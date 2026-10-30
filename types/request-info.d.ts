// plugin-api ≤0.4.x types `originGatedFetch(input: RequestInfo | URL)`, and `RequestInfo` is a DOM-lib name
// @types/node does not declare, so this node-only plugin fails to typecheck plugin-api's own source. Fixed
// upstream in 0.5.0 (`Request | string | URL`); delete this file when the peer range moves there.
export {};
declare global {
  type RequestInfo = Request | string;
}
