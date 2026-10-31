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
| `data/site.json` | Site-wide text, ticket URL and navigation feature flags |
| `data/sponsors.json` | Sponsor names, websites and blurbs |
| `data/info.json` | Event details page content |
| `partials/nav.html` | Shared navigation markup |
| `partials/footer.html` | Shared footer markup |
| `images/brewstock-logo.svg` | Event logo placeholder |
| `images/brewstock-2026-social.png` | 1200×630 image used for social media link previews |
| `images/sponsors/` | Sponsor logo placeholders |

## How to make common changes

### Update text on a page
- **Home page:** edit `index.html`.
- **Event details page:** edit `data/info.json`. The text uses plain formatting:
  - Blank lines separate paragraphs.
  - Lines starting with `- ` or `• ` become bullet points.
  - Lines starting with `1. `, `2. ` etc. become numbered lists.

### Change the ticket link
Edit `data/site.json` and update `ticketUrl`. Also update `partials/nav.html` (and the fallback navigation in `index.html` and `info.html`) with the same URL if you want to change the link destination, text or placement.

### Show or hide the Beer List link
The **Beer List** link in the main navigation is hidden by default. To show it, set `showBeerList` to `true` in `data/site.json`:

```json
"showBeerList": true
```

Set it back to `false` to hide the link again. The link points to `https://beers.brewstock.org` and is defined in `partials/nav.html` (plus the fallback navigation in `index.html` and `info.html`) if the URL ever changes.

### Disable ticket sales
Set `ticketsAvailable` to `false` in `data/site.json` to grey out the **Buy tickets** button and show a not-allowed cursor. Clicks are also blocked while it is disabled:

```json
"ticketsAvailable": false
```

Set it back to `true` to re-enable the button. The navigation still shows the button so visitors can see tickets exist, but they cannot proceed to purchase.

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

### Update the social sharing image
When the site is shared on social media, the preview image comes from the `og:image` and `twitter:image` tags in `index.html` and `info.html`. Those tags point to `images/brewstock-2026-social.png`.

Social platforms do not support SVG previews, so that file is a 1200×630 PNG generated from `images/Brewstock 2026 Black and White.svg`. It is only referenced by the meta tags and is never displayed on the website. To regenerate it after changing the SVG (requires ImageMagick):

```bash
magick -background none -density 600 "images/Brewstock 2026 Black and White.svg" -resize 960x /tmp/brewstock-logo.png
magick -size 1200x630 xc:white /tmp/brewstock-logo.png -gravity center -composite -strip -depth 8 images/brewstock-2026-social.png
```

If you rename the PNG, update the `og:image` and `twitter:image` tags in both pages.

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
