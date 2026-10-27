// Schedule this service-only endpoint every five minutes in the isolated test
// environment after setting RECOVERY_SWEEP_SECRET and deploying both functions.
// The endpoint refuses all calls until the secret is configured.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizedSweep } from "./auth.mjs";
import { sweepAttachments } from "./sweep.mjs";

serve(async (req: Request) => {
  const secret = Deno.env.get("RECOVERY_SWEEP_SECRET") ?? "";
  if (!authorizedSweep(req.headers.get("Authorization"), secret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return new Response("Service unavailable", { status: 503 });

  const client = createClient(url, key, { auth: { persistSession: false } });
  try {
    const result = await sweepAttachments(client, {
      invoke: (name, options) => client.functions.invoke(name, options),
    });
    return Response.json(result);
  } catch (error) {
    console.error("[recovery-sweep]", error);
    return Response.json({ error: "recovery sweep failed" }, { status: 500 });
  }
});
