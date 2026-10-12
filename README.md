# Matside

Wrestling tournament software: brackets, bout numbers and times, mat-side scoring, live results, team scores and awards.
Folkstyle (NFHS, NCAA), freestyle and Greco-Roman.

- `index.html`: home page (start a tournament, your tournaments, open by link).
- `t/index.html`: the app. `?e=<id>` opens a tournament; `#a=<key>` (director) or `#s=<key>` (scorer) in a link is saved on the device. `?demo` runs a sample on this device only.
- `sbdb.js`: data layer on Supabase (cache + realtime + catch-up polling). `boot.js`: link keys, roles, share panel.
- `sw.js`: offline shell. `supabase/migrations/`: database (tables `ms_events`, `ms_docs`, functions `ms_*`).

Database: Supabase project `sirumors` (ref qzeygvpgdlmjbmhsfunt), `ms_` tables. Anyone can read; writes only through `ms_put` with the director or scorer key.
Scorers can write results, sheets, live, locks and calls only. Apply migrations through the Management API `/v1/projects/<ref>/database/query`.

`watchdog.yml` checks the site and database hourly and keeps one open `incident` issue until a fresh check passes.
