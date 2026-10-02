# GHIR9ELBL7ABA Shop

Node.js + Express thrift/vintage shop with direct orders and admin dashboard.

## Render
- Build Command: `npm install`
- Start Command: `npm start`
- Node: compatible with current Render Node runtimes.
- Required env var: `ADMIN_PASSWORD` (set your own strong password).

Open the service URL after deployment. `/admin` is the admin dashboard.

## Important
This starter stores products/orders in `data/store.json` on the local filesystem. Render web-service disks are ephemeral unless a persistent disk is configured. For a production store, connect a persistent database (Postgres/Supabase/etc.) before relying on it for permanent orders.
