// ==========================================
// turn-credentials — Supabase Edge Function
// ==========================================
// Выдаёт сайту временные учётные данные TURN-ретранслятора Cloudflare для
// звонка в совместном просмотре (w2g/w2g.js → loadWatchPartyTurn).
//
// Зачем: на мобильном интернете оператор прячет телефон за NAT, и два
// телефона не могут соединиться напрямую — видео и звук идут через
// ретранслятор. Постоянных паролей Cloudflare не даёт, а ключ API нельзя
// держать в браузере, поэтому временный пароль выдаёт эта функция.
//
// Секреты (Supabase → Edge Functions → Secrets):
//   CF_TURN_KEY_ID     — Turn Token ID из Cloudflare (Realtime → TURN Server)
//   CF_TURN_API_TOKEN  — API Token оттуда же
// SUPABASE_URL и SUPABASE_ANON_KEY Supabase подставляет сам.

import { createClient } from "jsr:@supabase/supabase-js@2";

const TTL_SECONDS = 86400; // сутки — с запасом на любой вечер просмотра

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

    // Только для вошедших на сайт: публичный anon-ключ сам по себе не подходит,
    // иначе кто угодно мог бы тратить наш трафик ретранслятора
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "Нужно войти на сайт" }, 401);

    const keyId = Deno.env.get("CF_TURN_KEY_ID");
    const apiToken = Deno.env.get("CF_TURN_API_TOKEN");
    if (!keyId || !apiToken) return json({ error: "TURN не настроен: нет секретов CF_TURN_KEY_ID / CF_TURN_API_TOKEN" }, 500);

    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
    });
    if (!res.ok) return json({ error: `Cloudflare ответил ${res.status}` }, 502);

    const data = await res.json();
    return json({ iceServers: data.iceServers, ttl: TTL_SECONDS });
});
