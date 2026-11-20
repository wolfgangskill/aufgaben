# Aufgaben-App

Persönliche Aufgabenliste als Web-App (PWA). Jede Aufgabe gehört zu genau einer Area.

- `docs/` – die Web-App (reines HTML/CSS/JavaScript, ohne Build). Wird über GitHub Pages ausgeliefert.
- `supabase/01_schema.sql` – Datenbank-Tabellen und Zugriffsregeln (Supabase / PostgreSQL).
- `supabase/functions/capture/` – kleine Funktion für die Schnellerfassung (Kurzbefehle).

Die Daten liegen in einer privaten Supabase-Datenbank hinter einer Anmeldung.
In diesem Repository stehen keine Geheimnisse. Der öffentliche Schlüssel in `docs/config.js`
ist für den Einsatz im Browser gedacht.

Lokal starten: `python3 -m http.server 8080 --directory docs` und dann `http://localhost:8080` öffnen.
