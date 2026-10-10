/*
 * PAWHE — Plex Account Watch History Exporter
 *
 * Exports the watch history of your Plex *account* (what watch.plex.tv records
 * under Account → Watch History) as a Simkl backup you can import at
 * https://simkl.com/apps/import/json/
 *
 * Usage
 *   1. Sign in and open https://watch.plex.tv/account/history
 *   2. Open the developer console, paste this whole file, press Enter.
 *   3. A file named `SimklBackup_<date>.zip` is downloaded. Upload it, unchanged.
 *
 * What gets exported
 *   - Every episode and movie with its exact watch date (UTC).
 *   - When an item was played more than once, only the FIRST play is kept,
 *     since Simkl stores one watch date per episode or movie. Set
 *     SAVE_ALL_PLAYS to also get every play, repeats included.
 *   - "Season N" bulk marks are expanded into every episode of that season.
 *
 * Plex exposes no IMDb/TMDb/TVDB ids, so Simkl matches on title + year. Use
 * TITLE_OVERRIDES and ID_OVERRIDES below for anything it resolves wrongly.
 *
 * MIT License.
 */
(() => {
  "use strict";

  // Optional. The script runs as-is; change these only to fix titles that
  // Simkl matched wrongly after an import.
  const SETTINGS = {
    /**
     * Plex title → title Simkl knows the item by.
     * Example: { "Some Show (US)": "Some Show" }
     */
    TITLE_OVERRIDES: {},

    /**
     * Pin a catalogue entry when title + year is ambiguous on Simkl.
     * Key: "movie|<title>|<year>" or "show|<title>|<year>". <title> is the title
     * written to the backup: the renamed one if TITLE_OVERRIDES renames the item,
     * otherwise the title exactly as Plex shows it.
     * Value: catalogue ids, e.g. simkl, imdb, tmdb.
     * Example: { "movie|Some Movie|2014": { imdb: "tt0000000", tmdb: "000000" } }
     */
    ID_OVERRIDES: {},

    /** Also save every raw play (repeats included) as a separate JSON file. */
    SAVE_ALL_PLAYS: false,

    /** Upper bound on history pages, in case pagination never ends. */
    PAGE_LIMIT: 500
  };

  // ======================================================================
  // Status panel
  // ======================================================================

  function createPanel() {
    const root = document.createElement("section");
    root.setAttribute("aria-live", "polite");
    Object.assign(root.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      width: "340px",
      maxHeight: "50vh",
      overflow: "auto",
      padding: "12px 14px",
      borderRadius: "10px",
      background: "#1f2326",
      color: "#e8e8e8",
      font: "12px/1.5 ui-monospace, Consolas, monospace",
      boxShadow: "0 6px 24px rgba(0,0,0,.45)"
    });

    const heading = document.createElement("strong");
    heading.textContent = "PAWHE";
    heading.style.display = "block";
    heading.style.marginBottom = "6px";

    const lines = document.createElement("ol");
    Object.assign(lines.style, { margin: "0", paddingLeft: "18px" });

    const closer = document.createElement("button");
    closer.textContent = "×";
    closer.title = "Close";
    Object.assign(closer.style, {
      position: "absolute",
      top: "6px",
      right: "8px",
      border: "0",
      background: "none",
      color: "inherit",
      fontSize: "16px",
      cursor: "pointer"
    });
    closer.addEventListener("click", () => root.remove());

    root.append(closer, heading, lines);
    document.body.append(root);

    let current = null;

    return {
      /** Start a new line in the log. */
      step(text) {
        current = document.createElement("li");
        current.textContent = text;
        lines.append(current);
        console.info(`[PAWHE] ${text}`);
      },
      /** Rewrite the latest line in place (for counters). */
      update(text) {
        if (current) current.textContent = text;
      },
      /** Add a warning line, then keep updating the line before it. */
      warn(text) {
        const previous = current;
        this.step(`Warning: ${text}`);
        current.style.color = "#ffd54f";
        current = previous;
      },
      fail(text) {
        this.step(text);
        current.style.color = "#ff8a80";
      },
      done(text) {
        this.step(text);
        current.style.color = "#9ccc65";
      }
    };
  }

  // ======================================================================
  // Collect: read the full history feed
  // ======================================================================

  /**
   * Rebuild the streamed RSC payload by concatenating every
   * `self.__next_f.push([1, "<chunk>"])` inline script on the page.
   */
  function readRscPayload() {
    let payload = "";

    for (const script of document.scripts) {
      if (script.src) continue;

      const match = script.textContent.match(
        /^self\.__next_f\.push\((\[.*\])\)\s*;?\s*$/s
      );

      if (!match) continue;

      try {
        const pushed = JSON.parse(match[1]);

        if (typeof pushed[1] === "string") {
          payload += pushed[1];
        }
      } catch (_) {}
    }

    return payload;
  }

  /**
   * Pull the JSON object or array that follows `"<key>":` out of a larger
   * string by matching brackets, skipping over anything inside string literals.
   */
  function extractJsonAfterKey(source, key) {
    const marker = `"${key}":`;
    const keyAt = source.indexOf(marker);

    if (keyAt === -1) return null;

    let start = keyAt + marker.length;

    while (source[start] === " ") start++;

    if (source[start] !== "{" && source[start] !== "[") return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i++) {
      const char = source[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;

        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, i + 1));
          } catch (_) {
            return null;
          }
        }
      }
    }

    return null;
  }

  function readInitialPage() {
    const payload = readRscPayload();

    const items = extractJsonAfterKey(payload, "watchHistory");
    const pagination = extractJsonAfterKey(payload, "pagination");

    if (!Array.isArray(items)) {
      throw new Error(
        "Could not find the watch history in the page. Open " +
          "https://watch.plex.tv/account/history and reload before running this."
      );
    }

    return {
      items,
      nextUrl: pagination && pagination.nextUrl ? pagination.nextUrl : null
    };
  }

  /**
   * watch.plex.tv proxies the luma backend. The target URL is percent-encoded
   * twice: once for the proxy's own `url` parameter, once because the proxy
   * decodes it before forwarding.
   */
  function toProxyUrl(lumaUrl) {
    return (
      "/api/luma?lumaCache=always-dynamic&url=" +
      encodeURIComponent(encodeURIComponent(lumaUrl))
    );
  }

  async function fetchHistoryPage(lumaUrl) {
    const response = await fetch(toProxyUrl(lumaUrl), { method: "POST" });

    if (!response.ok) {
      throw new Error(`History request failed (HTTP ${response.status}).`);
    }

    return response.json();
  }

  /** Walk `pagination.nextUrl` until the server stops handing one back. */
  async function collectAllItems(panel) {
    const initial = readInitialPage();
    const items = [...initial.items];

    let nextUrl = initial.nextUrl;
    let pages = 1;

    panel.step(`Page 1: ${items.length} plays`);

    while (nextUrl && pages < SETTINGS.PAGE_LIMIT) {
      const page = await fetchHistoryPage(nextUrl);
      const content = Array.isArray(page.content) ? page.content : [];

      items.push(...content);
      pages++;

      panel.update(`Page ${pages}: ${items.length} plays`);

      if (!content.length) break;

      nextUrl = page.pagination && page.pagination.nextUrl;
    }

    if (pages >= SETTINGS.PAGE_LIMIT) {
      console.warn(`[PAWHE] Stopped at the ${SETTINGS.PAGE_LIMIT}-page limit.`);
    }

    return items;
  }

  // ======================================================================
  // Normalize: one plain record per activity
  // ======================================================================

  // Plex separates the season and episode with a bullet or a middle dot.
  const EPISODE_SUBTITLE = /^S(\d+)\s*[•·]\s*E(\d+)/;
  const SEASON_SUBTITLE = /^Season\s+(\d+)/i;
  const EPISODE_URL = /^\/show\/([^/]+)\/season\/(\d+)\/episode\/(\d+)/;
  const SEASON_URL = /^\/show\/([^/]+)\/season\/(\d+)/;

  /** The exact UTC timestamp, carried by the row's "Edit Watched Date" action. */
  function getWatchedAt(item) {
    const action = (item.actions || []).find(
      candidate => candidate.id === "editWatchedDate"
    );

    return (action && action.data && action.data.watchedAt) || "";
  }

  function parseItem(item) {
    const url = (item.link && item.link.url) || "";
    const subtitle = (item.subtitles || [])[0] || "";

    const base = {
      id: item.id,
      title: item.title || "",
      url,
      subtitle,
      watchedAt: getWatchedAt(item)
    };

    const episodeUrl = url.match(EPISODE_URL);

    if (episodeUrl) {
      const fromSubtitle = subtitle.match(EPISODE_SUBTITLE);

      return {
        ...base,
        kind: "episode",
        showSlug: episodeUrl[1],
        season: Number(fromSubtitle ? fromSubtitle[1] : episodeUrl[2]),
        episode: Number(fromSubtitle ? fromSubtitle[2] : episodeUrl[3])
      };
    }

    const seasonUrl = url.match(SEASON_URL);

    if (seasonUrl) {
      // Plex logs one of these when a whole season is marked watched at once.
      const fromSubtitle = subtitle.match(SEASON_SUBTITLE);

      return {
        ...base,
        kind: "season",
        showSlug: seasonUrl[1],
        season: Number(fromSubtitle ? fromSubtitle[1] : seasonUrl[2])
      };
    }

    if (url.startsWith("/movie/")) {
      const year = subtitle.match(/\b(\d{4})\b/);

      return { ...base, kind: "movie", year: year ? Number(year[1]) : null };
    }

    return { ...base, kind: "unknown" };
  }

  /** The activity id is unique per play: dedupe on it, keep every real play. */
  function uniquePlays(items) {
    const byId = new Map();

    for (const item of items) {
      if (item && item.id && !byId.has(item.id)) byId.set(item.id, item);
    }

    return [...byId.values()].map(parseItem);
  }

  // ======================================================================
  // Enrich: data the history feed doesn't carry, scraped from Plex pages
  // ======================================================================

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const pageCache = new Map();

  /** Pages that never loaded with their content, so warnings can say so. */
  const unreadablePages = new Set();

  // Gap between page loads, and how often to try one page before giving up.
  // Each rate limit (HTTP 429) doubles the gap for the rest of the run, up to
  // MAX_REQUEST_GAP_MS, and waits at least RATE_LIMIT_WAIT_MS before retrying.
  const MIN_REQUEST_GAP_MS = 250;
  const MAX_REQUEST_GAP_MS = 2000;
  const RATE_LIMIT_WAIT_MS = 5000;
  const MAX_ATTEMPTS = 5;
  let requestGapMs = MIN_REQUEST_GAP_MS;
  let lastRequestAt = 0;

  /** Wait out the request gap, so a long history doesn't hammer Plex. */
  async function throttle() {
    const wait = lastRequestAt + requestGapMs - Date.now();
    if (wait > 0) await pause(wait);
    lastRequestAt = Date.now();
  }

  /** Plex is rate limiting: space out every later page load. */
  function slowDown() {
    const gap = Math.min(requestGapMs * 2, MAX_REQUEST_GAP_MS);
    if (gap !== requestGapMs) {
      console.info(`[PAWHE] Rate limited by Plex; slowing to one page every ${gap} ms`);
      requestGapMs = gap;
    }
  }

  /** Seconds from a Retry-After header, as milliseconds, or null. */
  function retryAfterMs(response) {
    const seconds = Number(response.headers.get("Retry-After"));
    return seconds > 0 ? Math.min(seconds, 60) * 1000 : null;
  }

  /**
   * Load a public watch.plex.tv page as text, without cookies: signed-in
   * renders sometimes come back without their season or episode lists, while
   * the anonymous page carries the same metadata reliably.
   *
   * A request can still fail, or answer 200 with a page that lacks its
   * content, so a page only counts as loaded once `hasContent(html)` agrees.
   * Retry with backoff, and only cache pages that loaded.
   */
  async function fetchHtml(path, hasContent) {
    if (pageCache.has(path)) return pageCache.get(path);
    if (unreadablePages.has(path)) return "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let backoff = 1500 * 2 ** (attempt - 1);

      try {
        await throttle();
        const response = await fetch(path, { credentials: "omit" });

        if (response.ok) {
          const html = await response.text();
          if (hasContent(html)) {
            pageCache.set(path, html);
            return html;
          }
          console.warn(
            `[PAWHE] ${path}: loaded without its content ` +
              `(${html.length} bytes, attempt ${attempt})`
          );
        } else {
          console.warn(`[PAWHE] ${path}: HTTP ${response.status} (attempt ${attempt})`);
          backoff = retryAfterMs(response) || backoff;

          if (response.status === 429) {
            slowDown();
            backoff = Math.max(backoff, RATE_LIMIT_WAIT_MS);
          }
        }
      } catch (error) {
        console.warn(`[PAWHE] ${path}: ${error.message} (attempt ${attempt})`);
      }

      if (attempt < MAX_ATTEMPTS) await pause(backoff);
    }

    unreadablePages.add(path);
    return "";
  }

  /** True when any page under /show/<slug> failed to load. */
  function hadUnreadablePages(slug) {
    const prefix = `/show/${slug}`;
    return [...unreadablePages].some(
      path => path === prefix || path.startsWith(`${prefix}/`)
    );
  }

  function seasonLinkPattern(slug) {
    return new RegExp(`/show/${escapeRegExp(slug)}/season/(\\d+)`, "g");
  }

  function episodeLinkPattern(slug, season) {
    return new RegExp(`/show/${escapeRegExp(slug)}/season/${season}/episode/(\\d+)`, "g");
  }

  /** A show page counts as loaded once it links to at least one season. */
  function fetchShowPage(slug) {
    return fetchHtml(`/show/${slug}`, html => seasonLinkPattern(slug).test(html));
  }

  /** Shows carry no year in the history feed, so read it off the show page. */
  async function getShowYear(slug) {
    const html = await fetchShowPage(slug);
    const match = html.match(/releaseDate\\?"\s*:\s*\\?"(\d{4})-\d{2}-\d{2}/);

    if (!match) console.warn(`[PAWHE] No release year found for /show/${slug}`);

    return match ? Number(match[1]) : null;
  }

  /** Season numbers linked from the show page, specials (season 0) excluded. */
  async function getSeasonNumbers(slug) {
    const html = await fetchShowPage(slug);
    const numbers = new Set(
      [...html.matchAll(seasonLinkPattern(slug))].map(m => Number(m[1]))
    );

    numbers.delete(0);

    return [...numbers].sort((a, b) => a - b);
  }

  /** Episode numbers linked from a season page. */
  async function getEpisodeNumbers(slug, season) {
    const html = await fetchHtml(`/show/${slug}/season/${season}`, page =>
      episodeLinkPattern(slug, season).test(page)
    );
    const numbers = new Set(
      [...html.matchAll(episodeLinkPattern(slug, season))].map(m => Number(m[1]))
    );

    return [...numbers].sort((a, b) => a - b);
  }

  /** Total regular episodes of a show, or null if any season can't be read. */
  async function getEpisodeTotal(slug) {
    const seasons = await getSeasonNumbers(slug);
    if (!seasons.length) return null;

    let total = 0;

    for (const season of seasons) {
      const episodes = await getEpisodeNumbers(slug, season);
      if (!episodes.length) return null;
      total += episodes.length;
    }

    return total;
  }

  // ======================================================================
  // Reduce: first play per episode / movie
  // ======================================================================

  function displayTitle(title) {
    return SETTINGS.TITLE_OVERRIDES[title] || title;
  }

  function earlier(a, b) {
    return !b || Date.parse(a) < Date.parse(b) ? a : b;
  }

  function episodeCode(season, episode) {
    const two = n => String(n).padStart(2, "0");
    return `S${two(season)}E${two(episode)}`;
  }

  /**
   * Fold all plays into titles. Each episode/movie keeps the earliest
   * timestamp it was ever seen with.
   */
  async function reduceToTitles(plays, panel) {
    const shows = new Map(); // slug → { title, episodes: Map("s:e" → iso) }
    const movies = new Map(); // "title|year" → { title, year, watchedAt }
    const skipped = [];

    for (const play of plays) {
      if (!play.watchedAt) {
        skipped.push(play);
        continue;
      }

      if (play.kind === "movie") {
        const key = `${play.title}|${play.year}`;
        const entry = movies.get(key) || { title: play.title, year: play.year };
        entry.watchedAt = earlier(play.watchedAt, entry.watchedAt);
        movies.set(key, entry);
        continue;
      }

      if (play.kind !== "episode" && play.kind !== "season") {
        skipped.push(play);
        continue;
      }

      let episodes = [play.episode];

      if (play.kind === "season") {
        panel.update(`Expanding ${play.title} season ${play.season}`);
        episodes = await getEpisodeNumbers(play.showSlug, play.season);

        if (!episodes.length) {
          skipped.push(play);
          continue;
        }
      }

      const show = shows.get(play.showSlug) || {
        title: play.title,
        episodes: new Map()
      };

      for (const episode of episodes) {
        const key = `${play.season}:${episode}`;
        show.episodes.set(key, earlier(play.watchedAt, show.episodes.get(key)));
      }

      shows.set(play.showSlug, show);
    }

    return { shows, movies, skipped };
  }

  // ======================================================================
  // Emit: SimklBackup.json (the shape of Simkl's GET /sync/all-items)
  // ======================================================================

  function withIds(type, title, year) {
    return { ...(SETTINGS.ID_OVERRIDES[`${type}|${title}|${year}`] || {}) };
  }

  async function buildBackup({ shows, movies }, panel) {
    const backup = { shows: [], movies: [] };

    for (const [slug, show] of shows) {
      panel.update(`Looking up ${show.title}`);

      const title = displayTitle(show.title);
      const year = await getShowYear(slug);
      const total = await getEpisodeTotal(slug);

      if (hadUnreadablePages(slug)) {
        panel.warn(
          `couldn't load all Plex pages for ${title}` +
            (year ? "" : " (no release year, Simkl may mismatch it)") +
            (total === null ? ' (episode count unknown, left as "watching")' : "") +
            "; running the script again usually fixes this"
        );
      } else {
        if (!year) panel.warn(`no release year on Plex for ${title}; Simkl may mismatch it`);
        if (total === null) panel.warn(`episode count unknown for ${title}; left as "watching"`);
      }

      const watched = [...show.episodes]
        .map(([key, watchedAt]) => {
          const [season, episode] = key.split(":").map(Number);
          return { season, episode, watchedAt };
        })
        .sort((a, b) => a.season - b.season || a.episode - b.episode);

      const latest = watched.reduce((a, b) =>
        Date.parse(b.watchedAt) > Date.parse(a.watchedAt) ? b : a
      );

      const seasons = [];
      for (const item of watched) {
        let season = seasons[seasons.length - 1];
        if (!season || season.number !== item.season) {
          season = { number: item.season, episodes: [] };
          seasons.push(season);
        }
        season.episodes.push({ number: item.episode, watched_at: item.watchedAt });
      }

      backup.shows.push({
        last_watched_at: latest.watchedAt,
        status: total !== null && watched.length >= total ? "completed" : "watching",
        last_watched: episodeCode(latest.season, latest.episode),
        watched_episodes_count: watched.length,
        show: { title, year, ids: withIds("show", title, year) },
        seasons
      });
    }

    for (const movie of movies.values()) {
      const title = displayTitle(movie.title);

      backup.movies.push({
        last_watched_at: movie.watchedAt,
        status: "completed",
        movie: { title, year: movie.year, ids: withIds("movie", title, movie.year) }
      });
    }

    const byDate = (a, b) => Date.parse(a.last_watched_at) - Date.parse(b.last_watched_at);
    backup.shows.sort(byDate);
    backup.movies.sort(byDate);

    return backup;
  }

  /** Every emitted date must be the earliest play recorded for that item. */
  function assertFirstPlays(backup, plays) {
    const firsts = new Map();
    const note = (key, iso) => firsts.set(key, earlier(iso, firsts.get(key)));

    for (const play of plays) {
      if (!play.watchedAt) continue;
      if (play.kind === "movie") note(`m|${play.title}|${play.year}`, play.watchedAt);
      if (play.kind === "episode") {
        note(`e|${displayTitle(play.title)}|${play.season}|${play.episode}`, play.watchedAt);
      }
    }

    for (const entry of backup.movies) {
      const raw = Object.keys(SETTINGS.TITLE_OVERRIDES).find(
        k => SETTINGS.TITLE_OVERRIDES[k] === entry.movie.title
      );
      const key = `m|${raw || entry.movie.title}|${entry.movie.year}`;
      if (firsts.get(key) !== entry.last_watched_at) {
        throw new Error(`Date check failed for movie ${entry.movie.title}`);
      }
    }

    for (const entry of backup.shows) {
      for (const season of entry.seasons) {
        for (const episode of season.episodes) {
          const key = `e|${entry.show.title}|${season.number}|${episode.number}`;
          // Episodes only reached through a season bulk mark have no single play.
          if (firsts.has(key) && Date.parse(firsts.get(key)) < Date.parse(episode.watched_at)) {
            throw new Error(
              `Date check failed for ${entry.show.title} ` +
                episodeCode(season.number, episode.number)
            );
          }
        }
      }
    }
  }

  // ======================================================================
  // Package: a store-only .zip (Simkl rejects a bare .json)
  // ======================================================================

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** Build a zip archive holding `files` ({ name, bytes }) without compression. */
  function makeZip(files) {
    const now = new Date();
    const dosTime =
      (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate =
      ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const encoder = new TextEncoder();
    const parts = [];
    const directory = [];
    let offset = 0;

    const header = (size, fill) => {
      const buffer = new Uint8Array(size);
      fill(new DataView(buffer.buffer));
      return buffer;
    };

    for (const file of files) {
      const name = encoder.encode(file.name);
      const crc = crc32(file.bytes);
      const size = file.bytes.length;

      const local = header(30, v => {
        v.setUint32(0, 0x04034b50, true); // local file header signature
        v.setUint16(4, 20, true); // version needed
        v.setUint16(6, 0x0800, true); // flags: UTF-8 names
        v.setUint16(8, 0, true); // method: store
        v.setUint16(10, dosTime, true);
        v.setUint16(12, dosDate, true);
        v.setUint32(14, crc, true);
        v.setUint32(18, size, true);
        v.setUint32(22, size, true);
        v.setUint16(26, name.length, true);
        v.setUint16(28, 0, true);
      });

      const central = header(46, v => {
        v.setUint32(0, 0x02014b50, true); // central directory signature
        v.setUint16(4, 20, true); // version made by
        v.setUint16(6, 20, true); // version needed
        v.setUint16(8, 0x0800, true);
        v.setUint16(10, 0, true);
        v.setUint16(12, dosTime, true);
        v.setUint16(14, dosDate, true);
        v.setUint32(16, crc, true);
        v.setUint32(20, size, true);
        v.setUint32(24, size, true);
        v.setUint16(28, name.length, true);
        v.setUint32(42, offset, true); // where the local header starts
      });

      parts.push(local, name, file.bytes);
      directory.push(central, name);
      offset += local.length + name.length + size;
    }

    const directorySize = directory.reduce((sum, part) => sum + part.length, 0);

    const end = header(22, v => {
      v.setUint32(0, 0x06054b50, true); // end of central directory signature
      v.setUint16(8, files.length, true);
      v.setUint16(10, files.length, true);
      v.setUint32(12, directorySize, true);
      v.setUint32(16, offset, true);
    });

    return new Blob([...parts, ...directory, end], { type: "application/zip" });
  }

  function saveFile(blob, filename) {
    const href = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement("a"), {
      href,
      download: filename,
      style: "display:none"
    });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }

  // ======================================================================
  // Entry point
  // ======================================================================

  async function run() {
    if (window.PAWHE && window.PAWHE.busy) {
      console.warn("[PAWHE] Already running.");
      return;
    }

    window.PAWHE = { busy: true };
    const panel = createPanel();

    try {
      if (location.hostname !== "watch.plex.tv") {
        throw new Error("Open https://watch.plex.tv/account/history and run it there.");
      }

      panel.step("Reading watch history");
      const plays = uniquePlays(await collectAllItems(panel));
      if (!plays.length) throw new Error("The watch history is empty.");

      panel.step("Merging plays");
      const titles = await reduceToTitles(plays, panel);

      panel.step("Looking up show details");
      const backup = await buildBackup(titles, panel);
      assertFirstPlays(backup, plays);

      const episodes = backup.shows.reduce((n, s) => n + s.watched_episodes_count, 0);
      const stamp = new Date().toISOString().slice(0, 10);

      const json = JSON.stringify(backup, null, 2);
      saveFile(
        makeZip([{ name: "SimklBackup.json", bytes: new TextEncoder().encode(json) }]),
        `SimklBackup_${stamp}.zip`
      );

      if (SETTINGS.SAVE_ALL_PLAYS) {
        saveFile(
          new Blob([JSON.stringify(plays, null, 2)], { type: "application/json" }),
          `pawhe_all_plays_${stamp}.json`
        );
      }

      Object.assign(window.PAWHE, { plays, backup, skipped: titles.skipped });

      if (titles.skipped.length) {
        console.warn("[PAWHE] Not exported:", titles.skipped);
      }

      panel.done(
        `Saved SimklBackup_${stamp}.zip — ${backup.shows.length} shows ` +
          `(${episodes} episodes), ${backup.movies.length} movies, from ` +
          `${plays.length} plays` +
          (titles.skipped.length ? `; ${titles.skipped.length} skipped` : "")
      );
    } catch (error) {
      console.error("[PAWHE]", error);
      panel.fail(`Failed: ${error.message}`);
    } finally {
      window.PAWHE.busy = false;
    }
  }

  run();
})();
