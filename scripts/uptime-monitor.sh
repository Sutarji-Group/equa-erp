#!/usr/bin/env bash
# Pemantau uptime EKSTERNAL (NFR-02, NFR-28, US-M10-07 KP-2) — dijalankan GitHub Actions tiap 5 menit, DI LUAR Vercel,
# sehingga peringatan "layanan tidak dapat diakses" tetap terkirim walau aplikasi mati.
#
# Layanan yang diperiksa:
#   web  = web kantor        → GET $APP_URL/masuk
#   sync = API sinkron       → GET $APP_URL/api/health/sync (basis data terjangkau)
# Status disimpan di $STATE_DIR/<layanan>.down (waktu mulai UTC), dipertahankan antar-jalankan lewat actions/cache.
#   gagal pertama  → catat mulai + peringatan "TIDAK DAPAT DIAKSES" ke tim IT
#   pulih          → POST $APP_URL/api/monitor/outage {service, startedAt, endedAt} (gangguan + durasi tercatat di
#                    aplikasi, insiden service_down) + peringatan "PULIH"
# Kanal peringatan (opsional, isi salah satu/keduanya sebagai secret repositori):
#   ALERT_WEBHOOK_URL                              → POST JSON {"text": "..."} (Slack/Discord/Google Chat/gateway WA)
#   RESEND_API_KEY + ALERT_EMAIL_TO (+ ALERT_EMAIL_FROM) → e-mail lewat Resend
set -uo pipefail

APP_URL="${APP_URL:-}"
CRON_SECRET="${CRON_SECRET:-}"
STATE_DIR="${STATE_DIR:-.uptime-state}"
mkdir -p "$STATE_DIR"

if [ -z "$APP_URL" ]; then
  echo "APP_URL belum diisi — pemantauan dilewati."
  exit 0
fi

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

alert() {
  local text="$1"
  echo "PERINGATAN: $text"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -sS --max-time 20 -H "Content-Type: application/json" -d "{\"text\":\"$(json_escape "$text")\"}" "$ALERT_WEBHOOK_URL" >/dev/null || echo "Kirim webhook peringatan gagal."
  fi
  if [ -n "${RESEND_API_KEY:-}" ] && [ -n "${ALERT_EMAIL_TO:-}" ]; then
    local from="${ALERT_EMAIL_FROM:-EQUA Pemantau <onboarding@resend.dev>}"
    curl -sS --max-time 20 -H "Authorization: Bearer $RESEND_API_KEY" -H "Content-Type: application/json" \
      -d "{\"from\":\"$(json_escape "$from")\",\"to\":[\"$(json_escape "$ALERT_EMAIL_TO")\"],\"subject\":\"[EQUA] $(json_escape "$text")\",\"text\":\"$(json_escape "$text")\"}" \
      https://api.resend.com/emails >/dev/null || echo "Kirim e-mail peringatan gagal."
  fi
}

check() {
  local service="$1" label="$2" url="$3"
  local state="$STATE_DIR/$service.down"
  if curl -fsS --max-time 20 -o /dev/null "$url"; then
    if [ -f "$state" ]; then
      local started ended
      started="$(cat "$state")"
      ended="$(now_utc)"
      if [ -n "$CRON_SECRET" ] && curl -fsS --max-time 30 -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
        -d "{\"service\":\"$service\",\"startedAt\":\"$started\",\"endedAt\":\"$ended\"}" "$APP_URL/api/monitor/outage" >/dev/null; then
        rm -f "$state"
      else
        echo "Gangguan $service belum dapat dicatat ke aplikasi — dicoba lagi pada jalankan berikutnya."
      fi
      alert "$label PULIH (gangguan sejak $started UTC sampai $ended UTC)."
    else
      echo "$label: OK"
    fi
  else
    if [ ! -f "$state" ]; then
      now_utc >"$state"
      alert "$label TIDAK DAPAT DIAKSES ($url). Periksa Vercel/Neon; catat penyebab di Akses > Perangkat & sinkron."
    else
      echo "$label masih gangguan sejak $(cat "$state") UTC."
    fi
  fi
}

check web "Web kantor EQUA" "$APP_URL/masuk"
check sync "API sinkron EQUA" "$APP_URL/api/health/sync"
exit 0
