# Brewstock website

A static, two-page website for Brewstock — a Victorian home brew festival on **Saturday 7 November 2026**.

## Files

| File / folder | Purpose |
|---------------|---------|
| `index.html` | Home page with hero, about section and sponsor grid |
| `info.html` | Attendee details page (theme, music, RSA, transport, camping) |
| `css/styles.css` | Colours, typography, layout and responsive styles |
| `js/components.js` | Loads the shared navigation and footer |
| `js/sponsors.js` | Loads `data/sponsors.json` and renders the sponsor cards |
| `js/info.js` | Loads `data/info.json` and renders the event details page |
| `data/site.json` | Site-wide text and ticket URL |
| `data/sponsors.json` | Sponsor names, websites and blurbs |
| `data/info.json` | Event details page content |
| `partials/nav.html` | Shared navigation markup |
| `partials/footer.html` | Shared footer markup |
| `images/brewstock-logo.svg` | Event logo placeholder |
| `images/sponsors/` | Sponsor logo placeholders |

## How to make common changes

### Update text on a page
- **Home page:** edit `index.html`.
- **Event details page:** edit `data/info.json`. The text uses plain formatting:
  - Blank lines separate paragraphs.
  - Lines starting with `- ` or `• ` become bullet points.
  - Lines starting with `1. `, `2. ` etc. become numbered lists.

### Change the ticket link
Edit `data/site.json` and update `ticketUrl`. The link is used in the navigation button and on the home-page hero. Also update `partials/nav.html` if you want to change the link text or placement.

### Add, remove or edit a sponsor
1. Open `data/sponsors.json`.
2. Add, remove or edit an entry. Each sponsor needs:
   - `name` — the sponsor's name
   - `slug` — a short, URL-friendly identifier (e.g. `keg-king`)
   - `website` — the sponsor's website URL
   - `blurb` — a one-paragraph description
3. Place the sponsor's logo at `images/sponsors/{slug}.svg` (preferred) or `images/sponsors/{slug}.png`.
4. If you change the image extension, also update `js/sponsors.js` where `imagePath` is set.

### Add a new page
1. Copy `info.html` to a new file (e.g. `about.html`).
2. Update `<title>`, `<body data-page="...">`, and the page content.
3. Add a link to the new page in `partials/nav.html` and in the fallback navigation inside `index.html` and `info.html`.
4. Update the `data-page` value on the new page's body tag and add a matching `data-page` attribute to the new nav link.

### Change colours or fonts
Edit the custom properties at the top of `css/styles.css`. The earthy palette is defined there so a single change updates the whole site.

### Replace the logo
Drop the final horizontal logo into `images/` and update the `<img>` tags in `partials/nav.html` and the fallback markup in `index.html` / `info.html`. The header uses deep forest/earth tones so a logo with white text and green highlights should display clearly.

## Serving the site

No server-side code is needed. You can open the files directly in a browser, or serve them with any static host (GitHub Pages, Netlify, AWS S3, etc.).

Because the navigation and sponsors are loaded with JavaScript, pages should be previewed through a local server for the includes to work:

```bash
cd "static websites"
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

If JavaScript is disabled, the pages still work because each page contains fallback navigation and footer markup.
