import { server } from '../serve.mjs';

export default function handler(req, res) {
  return server.emit('request', req, res);
}
