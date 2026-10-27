export function authorizedSweep(header, secret) {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (token.length !== secret.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return mismatch === 0;
}
