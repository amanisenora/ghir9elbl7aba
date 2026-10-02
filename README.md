# GHIR9ELBL7ABA Shop v3

Real direct-order thrift/vintage shop for Render.

## Render
- Build Command: `npm install`
- Start Command: `npm start`
- Environment variable: `ADMIN_PASSWORD` = choose a private password.

Open `/admin.html` to manage products and orders.

Important: this version stores data in `data/store.json` and uploads in `public/uploads`. On Render's free ephemeral filesystem, data can be lost after a rebuild/redeploy. For permanent production data, connect a persistent database/storage before launch.
