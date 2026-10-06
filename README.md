# Festival of Bharat — New Standalone Reel Maker

Standalone reel-making web app for Festival of Bharat.

## Render
Runtime: Node
Build: npm install
Start: npm start
Health: /health

Optional environment variables:
- JAMENDO_CLIENT_ID (Jamendo Developer client ID for licensed music catalog search)
- GOOGLE_CSE_KEY
- GOOGLE_CSE_ID

Without Google credentials, the app can use Openverse/Wikimedia search.

### Music search
The Music section searches the Jamendo catalog through the server-side `/music-search` endpoint. It supports in-app preview, selection and start/end trimming. The endpoint requests tracks marked for Jamendo Pro licensing. A Jamendo developer client ID is required. Instagram/Edits private music is not scraped or downloaded; after export, Instagram/Edits can be used to add its approved in-app music.

The browser performs reel preview/export; Render hosts the application and media proxy.