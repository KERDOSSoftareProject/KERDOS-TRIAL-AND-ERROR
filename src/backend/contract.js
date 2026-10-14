// KERDOS owns this contract. Providers implement it; screens never define it.
// Keep capability names about business needs, not vendor products or syntax.
export const BACKEND_CAPABILITIES = Object.freeze([
  "session", "workspace", "documents", "realtime", "pricing", "catalog", "invoices", "team", "records",
]);

export function assertBackendContract(backend) {
  if (!backend || typeof backend !== "object") throw new Error("KERDOS backend is not configured");
  for (const capability of BACKEND_CAPABILITIES) {
    if (!backend[capability]) throw new Error(`KERDOS backend is missing ${capability}`);
  }
  const methods = {
    session:["get","subscribe","signIn","signUp","signOut"],
    workspace:["memberships","snapshot"],
    documents:["upload","signedUrl","remove","deletePriceSheet","deleteInvoiceRecord"],
    realtime:["subscribeToOrganization"],
    pricing:["applyQuote"],
    catalog:["saveRow"],
    invoices:["record"],
    team:["acceptInvite"],
    records:["query"],
  };
  for (const [capability,names] of Object.entries(methods)) {
    for (const name of names) if (typeof backend[capability][name] !== "function")
      throw new Error(`KERDOS backend ${capability}.${name} is not implemented`);
  }
  return backend;
}

export class BackendError extends Error {
  constructor(operation, cause) {
    super(`${operation}: ${cause?.message || String(cause || "unknown provider error")}`);
    this.name="BackendError";
    this.operation=operation;
    this.cause=cause;
  }
}

export async function providerResult(promise, operation) {
  try {
    const result=await promise;
    if(result?.error) throw result.error;
    return result?.data;
  } catch (error) {
    if(error instanceof BackendError) throw error;
    throw new BackendError(operation,error);
  }
}
