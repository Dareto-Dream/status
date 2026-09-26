# Status

Public status page for every `*.deltavdevs.com` hostname, at https://status.deltavdevs.com. No sign-in and no cookies. It runs as its own service with its own database, so it stays up when other sites are down.

## How it works

- Every hostname in `TARGETS` (`src/checks.js`) is requested once a minute, whether it's on Railway or not.
- Up means the server answered with anything below 500, so an API that 404s at `/` and a forward that redirects both count as up. Down means a 5xx, a timeout (10 s) or no connection, and the reason is shown ("domain not found", "certificate doesn't cover this name").
- Raw checks are kept 14 days, which gives the outage list. Daily totals are kept for good, which gives the 90-day bars.
- `/status.json` is the same data for anything else to read (CORS open, cached 20 s).

Add or remove hostnames in `TARGETS`.

## Setup

Set `DATABASE_URL`. Migrations run on start.

```sh
npm install
npm run dev   # uses .env
TEST_PG_URL=postgres://user:pass@localhost:5432/postgres npm test   # creates status_test
```
