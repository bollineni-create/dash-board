// Gridline looks for this to know requests can go through the relay.
export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send('gridline-api-proxy');
}
