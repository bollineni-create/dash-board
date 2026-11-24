// Gridline's server route for the hosted site (/gridline/api/* is rewritten here).
// "Ask anything" search: Gridline parses plain English in the browser for free and only
// calls this route when its parser can't read the whole question ("something reliable for
// a road trip with two dogs", "what's the best first car for a teenager"). Claude Haiku
// turns the question into Gridline's search filters. Answers are cached on Vercel's CDN
// for a day, so a repeat question costs nothing. Runs only when ANTHROPIC_API_KEY is set;
// without it Gridline keeps its built-in parser.
import Anthropic from '@anthropic-ai/sdk';

export const aiEnabled = !!process.env.ANTHROPIC_API_KEY;
const client = aiEnabled ? new Anthropic() : null;
const MODEL = process.env.GRIDLINE_ASK_MODEL || 'claude-haiku-5-5';
const PER_10_MIN = Number(process.env.GRIDLINE_ASK_LIMIT) || 30;

const hits = new Map(); // ip -> [windowStart, count]; per instance, so it's a soft limit
function overLimit(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h[0] > 600_000) { hits.set(ip, [now, 1]); return false; }
  return ++h[1] > PER_10_MIN;
}

function sameSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const from = req.headers.origin || req.headers.referer || '';
  try { return new URL(from).host === req.headers.host; } catch { return false; }
}

const send = (res, status, data, cache = 'no-store') => res.status(status).setHeader('Cache-Control', cache).json(data);

// The values Gridline's filters understand. Anything else is dropped before it reaches the page.
export const ENUMS = {
  body: ['Truck', 'SUV', 'Sedan', 'Coupe', 'Convertible', 'Wagon', 'Minivan', 'Hatchback'],
  fuel: ['Gas', 'Hybrid', 'Plug-in Hybrid', 'Electric', 'Diesel'],
  drivetrain: ['AWD', '4WD', 'FWD', 'RWD'],
  transmission: ['Manual', 'Automatic', 'CVT'],
  condition: ['New', 'Used', 'Certified'],
  colorFamily: ['Red', 'Blue', 'Black', 'White', 'Gray', 'Silver', 'Green', 'Brown', 'Beige', 'Orange', 'Yellow', 'Purple'],
  features: ['Leather Seats', 'Heated Seats', 'Ventilated Seats', 'Panoramic Roof', 'Sunroof/Moonroof', 'Apple CarPlay', 'Android Auto',
    'Third-Row Seating', 'Tow Package', 'Navigation', 'Head-Up Display', '360° Camera', 'Adaptive Cruise Control', 'Blind Spot Monitor',
    'Remote Start', 'Heated Steering Wheel', 'Premium Audio', 'Air Suspension', 'Off-Road Package', 'Hands-Free Driving',
    'Wireless Charging', 'Power Liftgate'],
  sort: ['best-deal', 'price-asc', 'price-desc', 'miles-asc', 'year-desc', 'newest'],
};
const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

const list = (values, description) => ({ type: 'array', items: { type: 'string', enum: values }, description });
const num = (description) => ({ anyOf: [{ type: 'integer' }, { type: 'null' }], description });
const SCHEMA = {
  type: 'object',
  properties: {
    makes: { type: 'array', items: { type: 'string' }, description: 'Brands, spelled as the manufacturer does (Mercedes-Benz, Land Rover). Empty unless the question names or implies specific brands.' },
    models: {
      type: 'array',
      items: { type: 'object', properties: { make: { type: 'string' }, model: { type: 'string' } }, required: ['make', 'model'], additionalProperties: false },
      description: 'Specific models, at most 8. Use these when the question asks for a judgement ("most reliable", "best for a teenager"): pick the models a well-informed car buyer would.',
    },
    body: list(ENUMS.body, 'Body styles.'),
    fuel: list(ENUMS.fuel, 'Fuel types.'),
    drivetrain: list(ENUMS.drivetrain, 'Drivetrains. Snow or off-road usually means AWD/4WD.'),
    transmission: list(ENUMS.transmission, 'Transmissions.'),
    condition: list(ENUMS.condition, 'New, used or certified pre-owned.'),
    colors: list(ENUMS.colorFamily, 'Exterior colors.'),
    features: list(ENUMS.features, 'Must-have features.'),
    states: { type: 'array', items: { type: 'string', enum: STATES }, description: 'US states, only when the question names one.' },
    yearMin: num('Oldest model year.'), yearMax: num('Newest model year.'),
    priceMin: num('Lowest price in dollars.'), priceMax: num('Highest price in dollars ("under 25k" = 25000).'),
    milesMax: num('Most miles on the odometer.'),
    nearMe: { type: 'boolean', description: 'True when the user wants cars near them ("near me", "nearby", "local").' },
    near: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'A 5-digit ZIP code, or "City, ST", when the question names a place.' },
    radius: num('Search radius in miles, when given.'),
    sort: { anyOf: [{ type: 'string', enum: ENUMS.sort }, { type: 'null' }], description: 'price-asc for cheapest, best-deal for deals/bargains.' },
    belowMarket: { type: 'boolean', description: 'True when they want deals or below-market prices.' },
    note: { type: 'string', description: 'One short sentence (max 20 words) telling the user how you read the question, e.g. "Reliable 3-row SUVs with room for dogs, under $30k". No filler.' },
    offTopic: { type: 'boolean', description: 'True only when the question has nothing to do with finding a car to buy.' },
  },
  required: ['makes', 'models', 'body', 'fuel', 'drivetrain', 'transmission', 'condition', 'colors', 'features', 'states',
    'yearMin', 'yearMax', 'priceMin', 'priceMax', 'milesMax', 'nearMe', 'near', 'radius', 'sort', 'belowMarket', 'note', 'offTopic'],
  additionalProperties: false,
};

const SYSTEM = `You turn a car shopper's question into search filters for Gridline, a US used and new car listings search. \
Today is ${new Date().toISOString().slice(0, 10)}. Fill only the filters the question asks for or clearly implies; \
leave everything else empty or null, because every filter you add hides cars. "Luxury" means luxury brands; \
"under 25k" means priceMax 25000; "cheap" means sort price-asc. When the question asks for advice ("most reliable", \
"good for snow", "first car"), answer it by choosing specific models and any filters that follow from the advice. \
Prices are what a shopper pays today, so keep budgets realistic rather than adding a priceMax the user didn't give.

Rules that keep good cars from being hidden:
- Add a feature only when the user names that feature. Listings often leave features out, so a feature filter \
hides many good matches ("tow a boat" means trucks that tow well, not the Tow Package filter).
- When the question names something there is no filter for (range, horsepower, mpg, cargo space, towing capacity, \
seats, reliability, resale value), pick 4 to 8 specific models known to meet it, and add the fuel or drivetrain \
it implies.
- "Like X but Y" or "alternatives to X": pick alternatives and leave X out unless it truly meets Y.
- When you pick models, leave makes and body empty: the models already say both.
- "Is X worth it" or "X review" about one model: return that model alone so they can see its prices.
- Rideshare (Uber, Lyft): reliable, efficient 4-door sedans, hybrids and small SUVs, model year 2012 or newer.`;

const clean = (arr, allowed) => [...new Set((Array.isArray(arr) ? arr : []).filter((v) => allowed.includes(v)))];
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

// Keep only values Gridline can use, so a bad answer narrows nothing it shouldn't.
export function sanitize(a) {
  const year = new Date().getFullYear() + 1;
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    makes: [...new Set((a.makes || []).map((m) => str(m, 40)).filter(Boolean))].slice(0, 25),
    models: (a.models || []).map((m) => ({ make: str(m && m.make, 40), model: str(m && m.model, 60) })).filter((m) => m.make && m.model).slice(0, 8),
    body: clean(a.body, ENUMS.body), fuel: clean(a.fuel, ENUMS.fuel), drivetrain: clean(a.drivetrain, ENUMS.drivetrain),
    transmission: clean(a.transmission, ENUMS.transmission), condition: clean(a.condition, ENUMS.condition),
    colors: clean(a.colors, ENUMS.colorFamily), features: clean(a.features, ENUMS.features), states: clean(a.states, STATES),
    yearMin: int(a.yearMin, 1950, year), yearMax: int(a.yearMax, 1950, year),
    priceMin: int(a.priceMin, 0, 5_000_000), priceMax: int(a.priceMax, 500, 5_000_000), milesMax: int(a.milesMax, 0, 1_000_000),
    nearMe: a.nearMe === true, near: /^\d{5}$|^[A-Za-z .'-]{2,40}, [A-Z]{2}$/.test(str(a.near, 60)) ? str(a.near, 60) : null,
    radius: int(a.radius, 1, 3000), sort: ENUMS.sort.includes(a.sort) ? a.sort : null, belowMarket: a.belowMarket === true,
    note: str(a.note, 160), offTopic: a.offTopic === true,
  };
}

async function ask(q) {
  const base = { model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: q }] };
  let params = { ...base, system: SYSTEM, output_config: { format: { type: 'json_schema', schema: SCHEMA } } };
  let response;
  try {
    response = await client.messages.create(params);
  } catch (e) {
    if (e.status !== 400) throw e;
    // The API turned the structured request down. Log why, then ask for the same JSON in words
    // so the search still works while the schema is fixed.
    console.error('gridline ask: structured output rejected:', e.message);
    params = { ...base,
      system: `${SYSTEM}\n\nReply with only a JSON object, no prose and no code fence, matching this JSON Schema exactly ` +
        `(use only the listed enum values; models are {make, model} objects):\n${JSON.stringify(SCHEMA)}` };
    response = await client.messages.create(params);
  }
  if (response.stop_reason === 'refusal') return { offTopic: true, note: '' };
  try {
    return sanitize(readJson(response));
  } catch (e) {
    // Rare: a reply cut short or wrapped in extra text. Log what came back and ask once more,
    // the same way that just worked (never re-sending a schema the API already rejected).
    console.error('gridline ask: unreadable reply', response.stop_reason, JSON.stringify(response.content).slice(0, 600));
    return sanitize(readJson(await client.messages.create(params)));
  }
}

// The reply's JSON object, from the text blocks only.
export function readJson(response) {
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const route = url.searchParams.get('route') || '';
  try {
    if (route === 'status' && req.method === 'GET') return send(res, 200, { ai: aiEnabled });
    if (route === 'ask' && req.method === 'GET') {
      if (!aiEnabled) return send(res, 503, { error: 'Ask anything is off on this server.' });
      if (!sameSite(req)) return send(res, 403, { error: 'Forbidden' });
      // Normalized, so "Aston Martins near me?" and "aston martins near me" share one cached answer.
      const q = String(url.searchParams.get('q') || '').toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+$/, '').trim();
      if (!q) return send(res, 400, { error: 'q is required' });
      if (q.length > 240) return send(res, 413, { error: 'That question is too long.' });
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      if (overLimit(ip)) {
        res.setHeader('Retry-After', '120');
        return send(res, 429, { error: 'Too many questions for now. Try again in a couple of minutes.' });
      }
      return send(res, 200, await ask(q), 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('gridline ask failed:', e.status || '', e.message);
    send(res, 502, { error: 'Couldn’t read that question right now.' });
  }
}
