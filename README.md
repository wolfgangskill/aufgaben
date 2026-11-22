# Aufgaben-App

Persönliche Aufgabenliste und Notizen als Web-App (PWA). Jede Aufgabe und jede Notiz gehört zu genau einer Area.

- `docs/` – die Web-App (reines HTML/CSS/JavaScript, ohne Build). Wird über GitHub Pages ausgeliefert.
- `supabase/01_schema.sql` – Datenbank-Tabellen für Areas und Aufgaben samt Zugriffsregeln (Supabase / PostgreSQL).
- `supabase/02_notes.sql` – Tabelle für Notizen (nach 01 ausführen).
- `supabase/03_search.sql` – Suche über Aufgaben und Notizen (deutscher Wortstamm plus Wortteil).
- `supabase/04_tags.sql` – Tags für Aufgaben und Notizen, Suche kennt Tags.
- `supabase/05_pin.sql` – Notizen anheften.
- `supabase/functions/capture/` – kleine Funktion für die Schnellerfassung (Kurzbefehle).

Die Daten liegen in einer privaten Supabase-Datenbank hinter einer Anmeldung.
In diesem Repository stehen keine Geheimnisse. Der öffentliche Schlüssel in `docs/config.js`
ist für den Einsatz im Browser gedacht.

Lokal starten: `python3 -m http.server 8080 --directory docs` und dann `http://localhost:8080` öffnen.
