# Brewstock website

A static, two-page website for Brewstock — a Victorian home brew festival on **Saturday 7 November 2026**.

## Files

| File / folder | Purpose |
|---------------|---------|
| `index.html` | Home page with hero, about section and sponsor grid |
| `info.html` | Attendee details page (theme, music, RSA, transport, camping) |
| `gallery.html` | Unlisted photo gallery (thumbnail grid + full-size viewer) |
| `css/styles.css` | Colours, typography, layout and responsive styles |
| `js/components.js` | Loads the shared navigation and footer |
| `js/sponsors.js` | Loads `data/sponsors.json` and renders the sponsor cards |
| `js/info.js` | Loads `data/info.json` and renders the event details page |
| `js/gallery.js` | Loads `gallery.json` from the image bucket and runs the gallery viewer |
| `data/site.json` | Site-wide text, ticket URL and navigation feature flags |
| `data/sponsors.json` | Sponsor names, websites and blurbs |
| `data/info.json` | Event details page content |
| `partials/nav.html` | Shared navigation markup |
| `partials/footer.html` | Shared footer markup |
| `images/brewstock-logo.svg` | Event logo placeholder |
| `images/brewstock-2026-social.png` | 1200×630 image used for social media link previews |
| `images/sponsors/` | Sponsor logo placeholders |
| `photo-desk/` | Organiser tool for reviewing and organising photos (published, unlisted, credential-gated) |
| `testing/` | Node self-tests for the R2 signing client (not published) |
| `_config.yml` | GitHub Pages config that excludes `testing/` |

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

## Photo gallery

`gallery.html` is an unlisted page: it is not linked from the navigation, it is marked `noindex`, and `robots.txt`
disallows it. Share the URL directly with attendees.

The page fetches `https://img.brewstock.org/gallery.json` and renders thumbnails in the order stored in that file.

- **Photos per page** — defaults to 24, with 12, 48 and 96 available. The choice is remembered per browser. A pager
  appears under the grid when there is more than one page.
- **Viewer** — click a thumbnail for the full-size image. Previous/next buttons, arrow keys and swipe move between
  photos; Escape, the Close button or a click on the backdrop return to the grid. Opening a photo from a later page
  keeps the grid in sync when you close it.
- **Zoom** — the `+` / `−` controls magnify the photo from "fit" up to 400% (`+`, `-` and `0` on the keyboard, or
  double-click the photo). While zoomed, drag with the mouse, scroll, or swipe to pan. The percentage shown is relative
  to the original file, so 100% means one image pixel per screen pixel.
- **Download** — saves the full-size original.

There is no top banner on this page: the photos start immediately below the site header.

For the gallery to work:

1. `gallery.json` must exist in the bucket root. The organiser tool creates it on the first accepted image.
2. The bucket **must** have a CORS policy that allows `GET` from `https://brewstock.org`. See
   [Bucket CORS is a prerequisite](#bucket-cors-is-a-prerequisite) — neither the gallery nor the organiser tool can work
   without it.

Images are served from the public base URL stored in `gallery.json` (`https://img.brewstock.org` by default). If the
domain changes, update the **Public image base URL** field the next time you use the organiser tool and save any change
(for example a reorder) so the new base URL is written to `gallery.json`.

## Organiser photo tool

The tool lives at `photo-desk/` and is served from the public site:

```
https://brewstock.org/photo-desk/
```

It is a static page: it talks straight to the R2 S3 API from your browser, so there is no server, no build step and no
dependency to install.

### What protects it

- **The gate is the R2 credentials.** Without a valid access key ID and secret, the page cannot list, read, write or
  delete anything. It fetches nothing until "Connect" succeeds, so an unauthorised visitor only ever sees the sign-in
  form. There is no hidden data in the HTML, JavaScript or CSS.
- **Unlisted.** Nothing on the site links to it. The path is deliberately not obvious, and the page is marked
  `noindex, nofollow` and is not listed in `robots.txt` (a `Disallow` entry would advertise the path).
- **No secrets in the repository.** Keys are typed into the form at run time and held in memory for that tab only.
  They are never written to the site, to disk, or to `localStorage`.

Be clear about the limits: the unlisted path is obscurity, not access control. Anyone who has the URL can load the form,
and anyone who also has a valid R2 key can use the tool — that is exactly the intent, but it means **the R2 token is the
only real secret**. Keep it to organisers, scope it to this one bucket with Object Read & Write, and revoke it from the
Cloudflare dashboard when it is no longer needed. If you later want real gatekeeping (named users, audit trail), put
Cloudflare Access in front of `/photo-desk/`.

### Bucket CORS is a prerequisite

The tool sends an `Authorization` header with every request, so the browser performs a CORS preflight. Until the
bucket has a CORS policy, **every** request fails and the tool reports *"Could not reach R2"* — this is the single most
common setup problem, and it must be fixed in the Cloudflare dashboard first, because nothing running in a browser can
configure CORS before CORS allows it to talk to the bucket.

Cloudflare dashboard → **R2** → images bucket → **Settings** → **CORS Policy** → **Add CORS policy**, then paste:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

`"*"` only controls which pages may *ask* for the data. Objects are already public on `img.brewstock.org`, and writes
still require a correctly signed request with your secret key.

### Connecting

1. Put the CORS policy in place (previous section).
2. Create the API token: **R2 → Manage R2 API Tokens → Create API token**, permission **Object Read & Write**, scoped
   to the images bucket. Copy the access key ID and secret access key shown at creation time.
3. Open `https://brewstock.org/photo-desk/`, enter the account ID (32-character hex string on **R2 → Overview**), bucket
   name and keys. The public image base URL is pre-filled with `https://img.brewstock.org`.
4. Connect, then run **Bucket health → Run connection test**.

Access keys are held in memory for the current tab only. They are never written to the site, to disk or to browser
storage. If **Remember account, bucket and public URL in this browser** is ticked, only those non-secret values are
stored in `localStorage`; the keys are always cleared when the page is reloaded.

### Testing against a real bucket

Connecting only reads the bucket. Nothing is changed until you accept, archive, reorder or run a cleanup action.

1. Make sure the CORS policy above is in place, then connect.
2. Go to **Bucket health → Run connection test**. It lists the bucket, writes and reads back a small object under
   `connection-check/`, deletes it, and loads a public thumbnail if one exists. All ticks means credentials and
   permissions are good. The temporary object is always removed.
3. Upload two or three test photos to the bucket root, press **Refresh**, and accept some while archiving others.
4. Check the Cloudflare dashboard: accepted images appear in `large/`, their thumbnails in `thumbs/`, archived images in
   `archive/`, and `gallery.json` lists only the accepted images in order.
5. To test the gallery, serve the site locally (`python3 -m http.server 8000`) and open
   `http://localhost:8000/gallery.html`. It fetches `https://img.brewstock.org/gallery.json`; the wildcard CORS policy
   allows the localhost origin. If you are testing a different bucket, temporarily change `DEFAULT_BASE_URL` in
   `js/gallery.js` and change it back afterwards.
6. Clean up: in **In gallery**, use **Remove → Delete permanently** for accepted test images (this deletes the large
   file, thumbnail and manifest entry). Delete any archived test files from `archive/` in the dashboard.

Common failures:

| Symptom | Cause |
|---------|-------|
| `Access denied (403)` on connect or list | Token is scoped to another bucket, or lacks Object Read & Write |
| `SignatureDoesNotMatch` | Account ID is wrong, or the computer clock is more than a few minutes out |
| `Could not reach R2`, or a CORS error in the browser console | Bucket CORS policy is missing — set it in the dashboard first |
| `net::ERR_NAME_NOT_RESOLVED` in the console | Account ID is wrong, so the endpoint hostname does not exist |
| `Not found (404)` on connect | Bucket name or account ID is wrong |
| Read/write passes but the public thumbnail fails | The bucket is not publicly served on the configured public base URL |
| HEIC card shows a decode error | Only Safari can decode HEIC; convert to JPEG or archive it |

### Bucket layout

```
gallery.json          manifest read by the gallery page
<uploads in root>     new images waiting for review
large/<filename>      full-size images shown in the lightbox
thumbs/<name>.jpg     500px JPEG thumbnails used by the grid
archive/<filename>    archived/ignored images, restorable from the Archived tab
```

### Reviewing new images

On connect the tool reads `gallery.json` and lists the bucket root:

- Images already listed in `gallery.json` appear on the **In gallery** tab as processed.
- Images in the root that are not listed appear on the **New images** tab.
- If `gallery.json` does not exist it is created the first time images are accepted.

Both grids are paged: **Images per page** (12, 24, 48 or 96, default 24) sits beside the tabs and applies to the
**New images** and **In gallery** grids. A Previous / "Page 1 of 2 · 1–24 of 60" / Next pager appears under each grid
when there is more than one page. **Select this page** ticks every image on the current page only — selections are kept
across pages, so you can build up a batch from several pages before choosing an action.

Click a thumbnail to open the full-size preview before deciding:

- `+` / `−`, the percentage label, the `+`, `-` and `0` keys, or a double-click magnify from fit up to 400% of the
  original. While magnified, drag with the mouse, scroll or swipe to pan.
- The arrow keys or the on-screen arrows move between images, including past the end of the current page — the grid
  follows along so closing the preview leaves you on the right page.
- **Select** toggles the current image's selection without leaving the preview.
- Escape, Close, or a click on the dark backdrop returns to the grid.

Tick images, then choose:

- **Accept & process** — the image is downloaded, a 500px JPEG thumbnail (quality 82, EXIF stripped, white matte for
  transparency) is written to `thumbs/`, the original is copied to `large/`, the root copy is deleted, and the entry is
  saved to `gallery.json`.
- **Archive selected** — the image is copied to `archive/`, the root copy is deleted, and no thumbnail or manifest
  entry is created.

Each accepted image is saved to `gallery.json` immediately, so an interrupted batch keeps everything already processed.
If a save fails the tool stops and offers a retry — retry before reloading the page, because unsaved in-memory entries
would be lost.

### Managing the gallery

- **In gallery** shows the manifest in display order, paged the same way. Drag a tile, or use the arrow buttons, to
  reorder. The new order is saved automatically.
- Click a thumbnail to preview the full-size image with the same zoom controls.
- **Remove** offers two options: archive the full-size file and delete its thumbnail, or delete both permanently.

### Restoring archived images

The **Archived** tab lists everything in `archive/`, paged like the other grids, so an image ignored during review can
still be added later.

- Thumbnails are never generated for archived images, so the tiles load the full-size file directly (lazily). With a
  large archive, lower **Images per page** to keep the tab light.
- Click a thumbnail to preview and zoom the image before deciding.
- **Restore** (on the tile, or **Restore to gallery** for a selection) downloads the image, writes a 500px thumbnail to
  `thumbs/`, moves the original from `archive/` to `large/`, appends the entry to `gallery.json`, and saves.
- Files that are already in the gallery are marked **Already in gallery** and skipped, so restoring twice cannot create
  duplicate entries. The batch report says how many were skipped.
- **Delete selected** removes archived files permanently.
- Restored images are appended to the end of the gallery order; drag them into position on the **In gallery** tab.

### Bucket health

The health tab checks for entries with a missing `large/` file or thumbnail, orphaned thumbnails, unreferenced large
files, and images that still exist in the root after being accepted. It also rebuilds thumbnails from `large/` files.
The CORS policy is shown read-only with a copy button — it has to be applied in the Cloudflare dashboard, because a
bucket without a CORS policy cannot serve the request that would apply one.

### `gallery.json` format

```json
{
  "version": 1,
  "baseUrl": "https://img.brewstock.org",
  "updatedAt": "2026-11-11T08:00:00.000Z",
  "images": [
    {
      "key": "IMG_0001.jpg",
      "large": "large/IMG_0001.jpg",
      "thumb": "thumbs/IMG_0001.jpg",
      "uploadedAt": "2026-11-11T08:00:00.000Z"
    }
  ]
}
```

The array order is the gallery order. Paths are relative to the bucket root; the gallery joins them to `baseUrl`.

### Supported formats

JPEG, PNG, WebP, GIF, AVIF and HEIC files are accepted. Thumbnail generation uses the browser's image decoder, so HEIC
files can only be processed in Safari (Chrome and Firefox cannot decode HEIC). A HEIC card shows a decode error and can
still be archived; convert it to JPEG first if it should appear in the gallery.

### Tool self-tests

The hand-written SigV4 signer is verified against the published AWS Signature Version 4 examples:

```bash
node testing/r2-signing.test.js
node testing/r2-client.test.js
```

## Serving the site

No server-side code is needed. You can open the files directly in a browser, or serve them with any static host (GitHub Pages, Netlify, AWS S3, etc.).

Because the navigation and sponsors are loaded with JavaScript, pages should be previewed through a local server for the includes to work:

```bash
cd "static websites"
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

If JavaScript is disabled, the pages still work because each page contains fallback navigation and footer markup.
