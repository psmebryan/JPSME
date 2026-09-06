// Passenger startup file.
//
// cPanel's "Setup Node.js App" (which is what GoDaddy's Node hosting is) asks
// for an "Application startup file" and defaults to app.js in the application
// root. Passenger then loads that file directly — it does not run `npm start`,
// and anything configured there is ignored.
//
// That distinction matters here, because `npm start` runs src/cluster.js, which
// forks worker processes of its own. Passenger already manages processes, so
// clustering underneath it means several workers racing for the same socket.
// This file exists so the obvious setting in the cPanel form is also the
// correct one: it starts a single server, and nothing else.
//
// Running locally is unchanged — `npm run dev` and `npm start` both still work
// as they did.

require('./src/server');
