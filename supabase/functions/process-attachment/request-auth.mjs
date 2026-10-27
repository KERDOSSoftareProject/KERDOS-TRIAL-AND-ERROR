/** Only the peer service-role caller may run the privileged worker. */
export function authorizedServiceRequest(header, serviceKey) {
  if (!serviceKey || !header?.startsWith("Bearer ")) return false;
  const value = header.slice(7);
  if (value.length !== serviceKey.length) return false;
  let mismatch = 0;
  for (let i = 0; i < value.length; i++) {
    mismatch |= value.charCodeAt(i) ^ serviceKey.charCodeAt(i);
  }
  return mismatch === 0;
}
