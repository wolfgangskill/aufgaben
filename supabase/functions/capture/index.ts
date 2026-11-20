// ============================================================
// Edge Function "capture": Eingangstür für die Schnellerfassung
//
//   GET  ...?format=text   -> Namen deiner Areas, eine pro Zeile
//   GET                    -> Areas als JSON (id + name)
//   POST {title, area}     -> legt eine Aufgabe an (area = Name der Area)
//   POST {title, area_id}  -> wie oben, aber mit der id der Area
//
// Schutz: Jede Anfrage braucht den Header "x-capture-token" mit dem
// geheimen Code (Secret CAPTURE_TOKEN). Der Datenbank-Schlüssel
// bleibt auf dem Server und verlässt ihn nie.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

// Server-Schlüssel: bevorzugt der neue (SUPABASE_SECRET_KEYS), sonst der alte.
function serverKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const value = keys.default ?? Object.values(keys)[0];
    if (typeof value === "string" && value) return value;
  } catch { /* weiter mit dem alten Schlüssel */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  serverKey(),
  { auth: { persistSession: false } },
);
const CAPTURE_TOKEN = Deno.env.get("CAPTURE_TOKEN") ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Vergleich in konstanter Zeit, damit der Code nicht durch Zeitmessung erraten werden kann.
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// Es gibt nur ein Konto (Registrierung ist gesperrt): das erste und einzige.
async function ownerId(): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error || !data.users.length) return null;
  return data.users[0].id;
}

Deno.serve(async (req) => {
  const token = req.headers.get("x-capture-token") ?? "";
  if (!CAPTURE_TOKEN || !safeEqual(token, CAPTURE_TOKEN)) {
    return json({ error: "Nicht erlaubt" }, 401);
  }

  const userId = await ownerId();
  if (!userId) return json({ error: "Kein Konto gefunden" }, 500);

  const { data: areas, error: areaError } = await supabase
    .from("areas")
    .select("id, name")
    .eq("user_id", userId)
    .order("sort_order")
    .order("name");
  if (areaError) return json({ error: areaError.message }, 500);

  if (req.method === "GET") {
    if (new URL(req.url).searchParams.get("format") === "text") {
      return new Response((areas ?? []).map((a) => a.name).join("\n"), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return json({ areas });
  }

  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Ungültiges JSON" }, 400);
    }

    const title = String(body.title ?? "").trim();
    if (!title || title.length > 500) {
      return json({ error: "title fehlt oder ist zu lang (max. 500 Zeichen)" }, 400);
    }

    const wantedName = String(body.area ?? "").trim().toLowerCase();
    const matches = (areas ?? []).filter((a) =>
      body.area_id ? a.id === String(body.area_id) : wantedName !== "" && a.name.trim().toLowerCase() === wantedName
    );
    if (matches.length === 0) return json({ error: "Area nicht gefunden" }, 404);
    if (matches.length > 1) return json({ error: "Area-Name ist nicht eindeutig" }, 409);

    const { data: task, error } = await supabase
      .from("tasks")
      .insert({ user_id: userId, area_id: matches[0].id, title })
      .select("id, title")
      .single();
    if (error) return json({ error: error.message }, 500);

    return json({ ok: true, task, area: matches[0].name }, 201);
  }

  return json({ error: "Methode nicht erlaubt" }, 405);
});
