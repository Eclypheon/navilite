/*
 * The layout measurement, as it runs *inside the page*.
 *
 * One source of truth for two drivers, because an iPhone is WebKit and the first harness was
 * Chrome:
 *
 *   - tools/layout-audit.mjs  — headless Chrome over CDP at the iPhone 15 Pro's own numbers.
 *   - tools/device-probe.mjs  — injects this file into a copy of dist/, which the iOS
 *     Simulator's Safari loads, so the numbers come out of real iOS WebKit with real
 *     safe-area insets. (That run is what answered the owner's report; Chrome was clean.)
 *
 * It reports two different things and never conflates them:
 *
 *   - `documentScrollWidth` vs `documentClientWidth`: is the *page* wider than the screen?
 *   - per-element: is this element hanging off the right edge, and is it a genuine offender
 *     or a child of a legitimate horizontal scroller (the tab strip)?
 *
 * Loaded as a plain script. Registers `window.__naviliteLayoutAudit`.
 */
(function () {
  /** iPhone 15 Pro, in CSS px, as the device reports them. */
  var DEVICE = {
    name: 'iPhone 15 Pro',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    safeAreaTop: 59,
    safeAreaBottom: 34,
  };

  var PATIENCE_MS = 20000;

  function selectorFor(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + '#' + node.id);
        break;
      }
      var cls = Array.prototype.slice.call(node.classList).slice(0, 3).join('.');
      if (cls) part += '.' + cls;
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === node.tagName;
        });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      if (node === document.body || node === document.documentElement) break;
    }
    return parts.join(' > ');
  }

  /**
   * The nearest ancestor that clips or scrolls sideways — an innocent parent, if any.
   *
   * v1.4 made the app one fixed shell with its own vertical scroll container, and a box with
   * `overflow-y: auto` computes `overflow-x: auto` too — so *every* element in the app now has a
   * horizontally-clipping ancestor. Treating that as an innocent parent would shield the next real
   * offender from this audit, which is exactly what the owner's 393 px regression test exists to
   * catch. So an ancestor only counts as a legitimate horizontal scroller when it can actually
   * scroll in x (it overflows: `scrollWidth > clientWidth`), or when it clips deliberately
   * (`hidden` / `clip`, where the page genuinely cannot grow sideways).
   */
  function clippingAncestor(el) {
    var node = el.parentElement;
    while (node && node !== document.documentElement) {
      var style = getComputedStyle(node);
      var overflowX = style.overflowX;
      if (overflowX === 'hidden' || overflowX === 'clip') return selectorFor(node);
      if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) {
        return selectorFor(node);
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * The thing a scroll gesture actually moves, and the header that must never move.
   *
   * v1.4 is the version that changed this: before it the document itself was the scroll context,
   * so `document.documentElement` was the surface. Now it is the app's own scroll container
   * (`.view-scroll`), and the document is deliberately frozen. A driver that measured only the
   * document from this version on would be measuring a box that cannot overflow by construction —
   * so the fallback here is the document, and it is reported, not guessed at.
   */
  function scrollSurfaces() {
    var doc = document.scrollingElement;
    return {
      header: document.querySelector('.topbar'),
      view: document.querySelector('.view'),
      scroller: document.querySelector('.view-scroll') || doc,
      document: doc,
      now: document.querySelector('.now'),
      lyrics: document.querySelector('.lyrics'),
      playlists: document.querySelector('.playerbar'),
    };
  }

  function horizontalOverflowOf(el) {
    return el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
  }

  /** An element has a real scroll distance when its content is taller than its box. */
  function scrollableBy(el) {
    return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
  }

  /**
   * `env(safe-area-inset-*)`, read the only way CSS exposes it: through a probe element's
   * computed padding. This is what tells a run whether it reproduced a notched iPhone.
   */
  function environment() {
    var probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(probe);
    var style = getComputedStyle(probe);
    var insets = {
      top: style.paddingTop,
      right: style.paddingRight,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
    };
    probe.remove();
    var doc = document.documentElement;
    return {
      userAgent: navigator.userAgent,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenWidth: window.screen ? window.screen.width : null,
      screenHeight: window.screen ? window.screen.height : null,
      devicePixelRatio: window.devicePixelRatio,
      visualViewportWidth: window.visualViewport ? Math.round(window.visualViewport.width * 10) / 10 : null,
      visualViewportScale: window.visualViewport ? window.visualViewport.scale : null,
      standalone:
        (window.navigator.standalone === true) ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches),
      viewportMeta: (function () {
        var meta = document.querySelector('meta[name=viewport]');
        return meta ? meta.getAttribute('content') : null;
      })(),
      safeAreaInsets: insets,
      documentClientWidth: doc.clientWidth,
      documentScrollWidth: doc.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    };
  }

  /**
   * The visual viewport, which is where an iOS focus-zoom shows up and *nowhere else*.
   *
   * v1.5. The owner reported "when i'm in the settings screen i still seem to be able to scroll
   * horizontally i think the dropdown option could be causing some overflow" — and there is no
   * layout overflow on that screen at 393 px (measured, in both engines). What there *is*: iOS
   * Safari zooms the page in when a form control smaller than 16 px takes focus, which makes the
   * layout wider than the screen and pannable sideways. The zoom lives in `visualViewport.scale`,
   * so that is what a run has to read; `documentElement.scrollWidth` stays clean throughout, which
   * is why a width-only audit can call the screen clean while the owner is panning it.
   */
  function viewportState() {
    var vv = window.visualViewport;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      vvWidth: vv ? round2(vv.width) : null,
      vvHeight: vv ? round2(vv.height) : null,
      vvScale: vv ? round2(vv.scale) : null,
      docClientWidth: document.documentElement.clientWidth,
      docScrollWidth: document.documentElement.scrollWidth,
    };
  }

  /**
   * Both surfaces the audit measures, kept apart.
   *
   * A single maximum hides which one moved, and the two mean different things: a *document* wider
   * than the screen is a page the owner can pan, while a *scroll surface* wider than its box is the
   * screen he is on being draggable sideways inside its own frame. Only naming them separately says
   * which fix the reading asks for.
   */
  function overflowSurfaces() {
    var surface = scrollSurfaces().scroller;
    return {
      surface: surface ? selectorFor(surface) : null,
      surfaceClientWidth: surface ? surface.clientWidth : null,
      surfaceScrollWidth: surface ? surface.scrollWidth : null,
      surfaceOverflow: horizontalOverflowOf(surface),
      documentOverflow: horizontalOverflowOf(document.documentElement),
    };
  }

  /**
   * The element inside the scroller with the most to scroll sideways.
   *
   * `actualOffenders` only names boxes whose *rectangle* leaves the screen, and a control with a long
   * option in it is not one of those: its box fits, its content does not. That is the shape that
   * widens a scroller without any element being visibly off-screen.
   */
  function widestInsideSurface() {
    var surface = scrollSurfaces().scroller;
    if (!surface) return null;
    var best = null;
    var all = surface.querySelectorAll('*');
    for (var i = 0; i < all.length; i += 1) {
      var over = horizontalOverflowOf(all[i]);
      if (over > 0 && (!best || over > best.overflow)) {
        best = {
          overflow: over,
          selector: selectorFor(all[i]),
          clientWidth: all[i].clientWidth,
          scrollWidth: all[i].scrollWidth,
          rectWidth: round2(all[i].getBoundingClientRect().width),
        };
      }
    }
    return best;
  }

  /**
   * Focus a form control the way a finger does, and report what the viewport did about it.
   *
   * `value` is optional: a long value is how "a long value in the field" gets measured rather than
   * assumed. The control is blurred again afterwards so the next step starts from a clean state.
   */
  function focusProbe(selector, value) {
    var el = document.querySelector(selector);
    if (!el) return Promise.reject(new Error('no element for ' + selector));
    if (typeof value === 'string') {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    var before = viewportState();
    var surfacesBefore = overflowSurfaces();
    var fontSize = getComputedStyle(el).fontSize;
    el.focus();
    return new Promise(function (resolve) {
      setTimeout(resolve, 700);
    }).then(function () {
      var after = viewportState();
      var surfacesAfter = overflowSurfaces();
      var detail = measure();
      el.blur();
      return {
        selector: selector,
        value: typeof value === 'string' ? value.slice(0, 80) : null,
        fontSize: fontSize,
        before: before,
        after: after,
        /** A ratio, not a boolean: 1.07 is an iOS focus-zoom, 1 is not. */
        zoom: Math.round(((after.vvScale || 1) / (before.vvScale || 1)) * 1000) / 1000,
        surfaceBeforeFocus: surfacesBefore,
        surfaceWhileFocused: surfacesAfter,
        /** The focused control's own box: a native control fits, its content may not. */
        control: {
          tag: el.tagName,
          className: String(el.className || ''),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          rectWidth: round2(el.getBoundingClientRect().width),
        },
        widestWhileFocused: widestInsideSurface(),
        overflowWhileFocused: detail.horizontalOverflow,
        offendersWhileFocused: detail.actualOffenders.map(function (item) {
          return item.selector;
        }),
      };
    });
  }

  /** Is the document wider than the viewport, and if so, which element did it? */
  function measure() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var doc = document.documentElement;
    var overflowers = [];
    var selfOverflow = [];
    /*
     * The surface the layout can actually push sideways. Since v1.4 that is the app's own scroll
     * container, not the document: the document is a fixed shell that clips, so measuring it alone
     * would report 0 px overflow for a layout built out of 600 px boxes. Both numbers are reported;
     * the failure threshold is the larger of the two, so neither surface can hide an offender.
     */
    var surface = scrollSurfaces().scroller;
    var surfaceOverflow = horizontalOverflowOf(surface);
    var documentOverflow = horizontalOverflowOf(doc);

    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      /*
       * v1.5: an element entirely to the left of the viewport cannot make the page wider — it can
       * only be a pane the pager has slid off the screen. Counting those as "offenders at left < 0"
       * would bury the real ones in noise, so they are skipped by position: a box that has no
       * pixels right of 0 has nothing to say about horizontal width.
       */
      if (rect.right <= 0.5) continue;
      if (rect.right > vw + 0.5 || rect.left < -0.5) {
        overflowers.push({
          selector: selectorFor(el),
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          overflow: Math.round((rect.right - vw) * 10) / 10,
          insideScroller: clippingAncestor(el),
          position: style.position,
          minWidth: style.minWidth,
          cssWidth: style.width,
          text: (el.textContent || '').trim().slice(0, 60),
        });
      }
      // An element whose own content is wider than the box it was given: the usual reason a
      // page grows, and the reason a wrap rule matters.
      if (el.scrollWidth > el.clientWidth + 1 && style.overflowX === 'visible' && style.display !== 'inline') {
        selfOverflow.push({
          selector: selectorFor(el),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          text: (el.textContent || '').trim().slice(0, 60),
        });
      }
    }

    var actual = [];
    var inside = [];
    for (var j = 0; j < overflowers.length; j += 1) {
      if (overflowers[j].insideScroller === null) actual.push(overflowers[j]);
      else inside.push(overflowers[j]);
    }

    // The tightest boxes in the layout: not offenders, but the ones that would *become* one.
    // An element sitting at exactly the viewport edge has zero slack, and "slightly too wide"
    // on a real phone is exactly that number being a fraction of a pixel over. Full-bleed
    // containers (`#app`, the fixed overlays) are excluded: being the width of the screen is
    // their whole job, so their slack is 0 by definition and says nothing.
    var edges = [];
    for (var k = 0; k < all.length; k += 1) {
      var candidate = all[k];
      var candidateStyle = getComputedStyle(candidate);
      if (candidateStyle.display === 'none' || candidateStyle.visibility === 'hidden') continue;
      var candidateRect = candidate.getBoundingClientRect();
      if (candidateRect.width < 24 || candidateRect.width >= vw - 0.5) continue;
      edges.push({
        selector: selectorFor(candidate),
        right: Math.round(candidateRect.right * 100) / 100,
        left: Math.round(candidateRect.left * 100) / 100,
        width: Math.round(candidateRect.width * 100) / 100,
        slack: Math.round((vw - candidateRect.right) * 100) / 100,
        scrollWidth: candidate.scrollWidth,
        clientWidth: candidate.clientWidth,
      });
    }
    edges.sort(function (a, b) {
      return a.slack - b.slack;
    });

    return {
      route: location.hash,
      innerWidth: vw,
      innerHeight: vh,
      viewport: viewportState(),
      documentClientWidth: doc.clientWidth,
      documentScrollWidth: doc.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      scrollingElementScrollWidth: doc.scrollingElement ? doc.scrollingElement.scrollWidth : null,
      /** The box a scroll gesture moves, and its horizontal numbers. */
      scrollSurface: selectorFor(surface),
      scrollSurfaceClientWidth: surface.clientWidth,
      scrollSurfaceScrollWidth: surface.scrollWidth,
      scrollSurfaceOverflow: surfaceOverflow,
      documentOverflow: documentOverflow,
      horizontalOverflow: Math.max(surfaceOverflow, documentOverflow),
      actualOffenders: actual,
      overflowersInsideScrollers: inside,
      selfOverflow: selfOverflow.slice(0, 12),
      tightestEdges: edges.slice(0, 8),
    };
  }

  /**
   * How much of the song the lyrics panel actually puts on screen, at this size.
   *
   * v1.2 made lyrics mode a full-height text screen, and "as much of the song as possible" is
   * only a claim if it has a number: this counts the lyric lines that fit *whole* inside the
   * panel, plus the line box height and the font size they were measured at.
   */
  function lyricsDensity() {
    var host = document.querySelector('.lyrics');
    if (!host) return null;
    var box = host.getBoundingClientRect();
    var lines = document.querySelectorAll('.lyric-line');
    var cover = document.querySelector('.now-cover');
    var coverBox = cover ? cover.getBoundingClientRect() : null;
    var visible = 0;
    var lineHeight = 0;
    for (var i = 0; i < lines.length; i += 1) {
      var rect = lines[i].getBoundingClientRect();
      if (lineHeight === 0) lineHeight = rect.height;
      if (rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5) visible += 1;
    }
    /*
     * v1.5: the first line, measured against the panel's own top edge rather than eyeballed.
     *
     * The owner reported "the first lyric line is clipped by the top bar". Two things can do that:
     * the line sitting above the panel, or the panel's own fade — `.lyrics` carries a mask that is
     * transparent over its top 16 px, so a line whose box starts inside that band is drawn faded
     * (which reads as clipped). `firstLineTop` is the gap between the panel's top and the first
     * line's top, so both are one number; `firstLineInFade` is the mask's opaque start.
     */
    var firstBox = lines.length > 0 ? lines[0].getBoundingClientRect() : null;
    return {
      lines: lines.length,
      visibleLines: visible,
      lineHeight: Math.round(lineHeight * 100) / 100,
      fontSize: lines[0] ? getComputedStyle(lines[0]).fontSize : null,
      panelHeight: Math.round(box.height * 100) / 100,
      panelTop: round2(box.top),
      // The element that clips it, if any (the scroll container's own box top).
      hostTop: round2(host.getBoundingClientRect().top),
      firstLineTop: firstBox ? round2(firstBox.top) : null,
      firstLineBottom: firstBox ? round2(firstBox.bottom) : null,
      /** The mask is transparent for the first 16 px: a line starting inside it is drawn faded. */
      firstLineInFade: firstBox ? firstBox.top - box.top < 16 : null,
      firstLineFullyInside: firstBox ? firstBox.top >= box.top - 0.5 && firstBox.bottom <= box.bottom + 0.5 : null,
      coverVisible: coverBox ? coverBox.height > 0 : false,
      coverHeight: coverBox ? Math.round(coverBox.height * 100) / 100 : 0,
    };
  }

  /**
   * The v1.5 pager's own geometry, mid-gesture included.
   *
   * The panes are the evidence: a drag that only *ends* somewhere can be a post-hoc animation, so
   * the harness reads these boxes while the finger is still down and checks that the incoming pane
   * moved by the distance the finger did — and that the two layers still tile, edge to edge, so no
   * empty space is ever exposed between them.
   */
  function nowGeometry() {
    var box = function (selector) {
      var el = document.querySelector(selector);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var style = getComputedStyle(el);
      return {
        selector: selector,
        left: round2(r.left),
        top: round2(r.top),
        right: round2(r.right),
        bottom: round2(r.bottom),
        width: round2(r.width),
        height: round2(r.height),
        translate: style.transform,
        overflow: style.overflow,
        scrollTop: round2(el.scrollTop),
        scrollHeight: Math.round(el.scrollHeight),
        clientHeight: Math.round(el.clientHeight),
      };
    };
    var now = document.querySelector('.now');
    return {
      route: location.hash,
      nowHidden: now ? now.classList.contains('hidden') : null,
      pager: pagerState(),
      now: box('.now'),
      pages: box('.now-pages'),
      spectrum: box('.now-page-spectrum'),
      lyricsPane: box('.now-page-lyrics'),
      panel: box('.lyrics'),
      list: box('.view-scroll'),
      activePill: (document.querySelector('.pill-option.active') || {}).textContent || null,
      context: (document.querySelector('.now-context') || {}).textContent || null,
      transport: document.querySelectorAll('.now-bar .transport').length,
    };
  }

  /**
   * What a finger would land on, at the centre of every control that has to keep working mid-drag.
   *
   * The (x/y) line, the transport and the pill sit *outside* the strip the panes slide in, which is
   * the whole reason they are still usable while a screen is arriving. Hit-testing them with the
   * finger still down is the honest form of that claim.
   */
  function controlHitTest() {
    var selectors = ['.now-context', '.now-bar .transport.big', '.pill-option.active', '.now-progress'];
    var out = [];
    for (var i = 0; i < selectors.length; i += 1) {
      var el = document.querySelector(selectors[i]);
      if (!el) {
        out.push({ selector: selectors[i], found: false });
        continue;
      }
      var r = el.getBoundingClientRect();
      var x = Math.round(r.left + r.width / 2);
      var y = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(x, y);
      out.push({
        selector: selectors[i],
        found: true,
        x: x,
        y: y,
        hit: hit ? selectorFor(hit) : null,
        insideControl: !!(hit && (hit === el || el.contains(hit))),
        insideNow: !!(hit && hit.closest && hit.closest('.now')),
        text: (el.textContent || '').slice(0, 60),
      });
    }
    return out;
  }

  /**
   * The lyrics panel's own scroll, the line that is lit, and where the *next* line is.
   *
   * v1.5 asks the follow to lead by one line — the upcoming line should be readable before the song
   * reaches it — so the upcoming line's box is what gets checked, not the active one's.
   */
  function lyricsFollowState() {
    var host = document.querySelector('.lyrics');
    if (!host) return null;
    var box = host.getBoundingClientRect();
    var nodes = Array.prototype.slice.call(host.querySelectorAll('.lyric-line'));
    var active = host.querySelector('.lyric-line.active');
    var activeIndex = active ? nodes.indexOf(active) : -1;
    var upcoming = activeIndex >= 0 ? nodes[activeIndex + 1] : null;
    var relative = function (node) {
      if (!node) return null;
      var r = node.getBoundingClientRect();
      return {
        top: round2(r.top - box.top),
        bottom: round2(r.bottom - box.top),
        fullyVisible: r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
        text: (node.textContent || '').slice(0, 24),
      };
    };
    return {
      scrollTop: round2(host.scrollTop),
      maxScroll: Math.max(0, Math.round(host.scrollHeight - box.height)),
      height: Math.round(box.height),
      lines: nodes.length,
      activeIndex: activeIndex,
      upcoming: upcoming ? Object.assign({ index: activeIndex + 1 }, relative(upcoming)) : null,
      active: relative(active),
      visible: nodes
        .map(function (node, index) {
          var r = node.getBoundingClientRect();
          return { index: index, visible: r.bottom <= box.bottom + 0.5 && r.top >= box.top - 0.5 };
        })
        .filter(function (item) {
          return item.visible;
        })
        .map(function (item) {
          return item.index;
        }),
    };
  }

  /**
   * A pixel reading of the spectrum canvas, right now.
   *
   * The owner's report is about a picture ("some after image or some separation of the colors at
   * the top of each bar"), so part of the evidence has to be pixels rather than intentions: this
   * is the number of lit pixels and a checksum over every byte of the canvas. The driver owns
   * the frames and the silence (see tools/spectrum-proof.mjs) — this only reads.
   */
  function spectrumSnapshot() {
    var canvas = document.querySelector('.now-canvas');
    if (!canvas || !canvas.width) return null;
    var c = canvas.getContext('2d');
    if (!c) return null;
    var data = c.getImageData(0, 0, canvas.width, canvas.height).data;
    var lit = 0;
    var sum = 0;
    for (var i = 0; i < data.length; i += 4) {
      // The bars are the palette colour over a near-black backdrop: anything clearly lit is a
      // bar (or an artefact pretending to be one).
      if (data[i + 3] > 8 && data[i] + data[i + 1] + data[i + 2] > 240) lit += 1;
      sum = (sum * 31 + data[i] * 7 + data[i + 1] * 3 + data[i + 2] * 11 + data[i + 3]) % 2147483647;
    }
    return {
      lit: lit,
      checksum: sum,
      canvas: canvas.width + 'x' + canvas.height,
      bytes: data.length,
      /** A PNG of this frame: identical pixels encode to an identical string, so two of these
       * compare byte for byte without shipping 500 kB of raw pixels through the driver. */
      png: canvas.toDataURL('image/png'),
    };
  }

  function waitFor(expression, label, timeoutMs) {
    var limit = timeoutMs || PATIENCE_MS;
    var deadline = Date.now() + limit;
    return new Promise(function (resolve, reject) {
      var tick = function () {
        var value;
        try {
          value = new Function('return (' + expression + ')')();
        } catch (error) {
          reject(new Error(label + ': ' + error.message));
          return;
        }
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('timed out waiting for ' + label));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function setHash(hash, waitExpression, label) {
    if (location.hash === hash) {
      // Same route: nudge it so the app re-renders, exactly like a tap would.
      location.hash = '';
      location.hash = hash;
    } else {
      location.hash = hash;
    }
    return waitFor(waitExpression, label);
  }

  function clickSelector(selector) {
    var el = document.querySelector(selector);
    if (!el) throw new Error('no element for ' + selector);
    el.click();
    return true;
  }

  /**
   * The pager, as the app reports it (v1.5). `null` on a build that has no pager — the older
   * payloads the same harness is run against for a before/after comparison.
   */
  function pagerState() {
    if (!window.__navilite || typeof window.__navilite.pager !== 'function') return null;
    try {
      return window.__navilite.pager();
    } catch (error) {
      return null;
    }
  }

  /**
   * Wait for the pager to stop moving, so a reading is of a screen at rest.
   *
   * With `expected` it also waits for that pane. That is not belt-and-braces: the app's route and
   * its pager are the same fact, but the *hashchange* that moves the pager arrives as its own task,
   * so a caller that has only just set `location.hash` finds the pager still resting on the old
   * pane with `settled: true` — and a "settle" check would return immediately and hand the next
   * reading a half-open screen. Measured: that is what made the first v1.5 run report 0 of 25
   * hit-test points inside the now screen.
   */
  function settlePager(expected) {
    if (!pagerState()) return Promise.resolve(null);
    if (typeof expected === 'number') return waitForPane(expected);
    return waitFor(
      "(function(){var p = window.__navilite.pager(); return Boolean(p) && p.settled === true;})()",
      'the pager to settle',
      8000,
    ).then(pagerState);
  }

  /** Wait until the pager is resting on a pane. Pane 0 is the playlist, 1 spectrum, 2 lyrics. */
  function waitForPane(index) {
    if (!pagerState()) return Promise.resolve(null);
    return waitFor(
      "(function(){var p = window.__navilite.pager(); return Boolean(p) && p.position === " +
        index +
        ' && p.settled === true;})()',
      'pane ' + index,
      8000,
    ).then(pagerState);
  }

  /**
   * Wait until a mode is showing, on either shape of the app: v1.5 asks the pager which pane it is
   * on, older builds are read from the `hidden` class the mode switch used to toggle.
   */
  function waitForMode(mode) {
    if (pagerState()) return waitForPane(mode === 'lyrics' ? 2 : 1);
    var selector = mode === 'lyrics' ? '.now-lyrics' : '.now-visualizer';
    return waitFor("!document.querySelector('" + selector + "').classList.contains('hidden')", mode + ' mode');
  }

  /** How many song rows are on screen — the "the list is loaded" signal. */
  function songRowCount() {
    return document.querySelectorAll('.row.song').length;
  }

  /**
   * Tap a song row the way a person does.
   *
   * v1.5 made the *whole row* the tap target and dropped the favourite button, so `.row-play` is a
   * decorative icon now rather than a control. The harness keeps working across both shapes: a real
   * `button.row-play` is clicked where it exists (v1.4 and earlier), otherwise the row itself is —
   * which is the thing v1.5 is claiming, so it gets exercised rather than assumed.
   */
  function playRow(index) {
    var rows = document.querySelectorAll('.row.song');
    if (rows.length === 0) throw new Error('no song rows on this screen');
    var row = rows[index || 0];
    var button = row.querySelector('button.row-play');
    if (button) {
      button.click();
      return 'button.row-play';
    }
    row.click();
    return 'the row itself';
  }

  /** A gesture in progress: finger down, moved sideways, not yet lifted. */
  function beginSwipe(selector) {
    var target = document.querySelector(selector);
    if (!target || typeof Touch !== 'function') return false;
    var make = function (x) {
      return new Touch({ identifier: 1, target: target, clientX: x, clientY: Math.round(window.innerHeight / 2) });
    };
    var start = make(window.innerWidth - 30);
    var moved = make(window.innerWidth - 90);
    target.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [start], targetTouches: [start], changedTouches: [start],
    }));
    target.dispatchEvent(new TouchEvent('touchmove', {
      bubbles: true, cancelable: true, touches: [moved], targetTouches: [moved], changedTouches: [moved],
    }));
    return true;
  }

  function endSwipe(selector) {
    var target = document.querySelector(selector);
    if (!target || typeof Touch !== 'function') return false;
    var point = new Touch({ identifier: 1, target: target, clientX: 40, clientY: Math.round(window.innerHeight / 2) });
    target.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [point],
    }));
    return true;
  }

  /**
   * Walk every route and both now-playing modes. Assumes the app is already connected: the
   * credential seeding is the driver's business (see the two drivers), because one of them
   * cannot survive a reload.
   */
  function walk(options) {
    var settings = options || {};
    var results = [];
    var list = [];

    var step = function (label, run, detail) {
      list.push(
        run()
          .then(function () {
            var state = Object.assign({ label: label, environment: environment() }, measure());
            if (typeof detail !== 'function') return state;
            /*
             * A detail may be async since v1.5: the focus-zoom reading needs a frame or two of
             * settling after the control takes focus, so a detail that returns a promise is
             * awaited rather than dropped on the floor.
             */
            var value;
            try {
              value = detail();
            } catch (error) {
              state.detail = { error: String(error) };
              return state;
            }
            if (value && typeof value.then === 'function') {
              return value.then(
                function (resolved) {
                  state.detail = resolved;
                  return state;
                },
                function (error) {
                  state.detail = { error: String((error && error.message) || error) };
                  return state;
                },
              );
            }
            state.detail = value;
            return state;
          })
          .then(function (state) {
            results.push(state);
          }),
      );
      return list[list.length - 1];
    };

    var chain = Promise.resolve();
    var queue = function (label, run, detail) {
      chain = chain.then(function () {
        if (typeof settings.onStep === 'function') {
          try {
            settings.onStep(label);
          } catch (error) {
            /* a progress hook must never break the walk */
          }
        }
        return step(label, run, detail);
      });
      return chain;
    };

    queue('Library (#/artists) — long Japanese artist name in the list', function () {
      return setHash('#/artists', "document.querySelectorAll('.row').length > 0", 'the artist list');
    });
    // The iOS focus-zoom. iOS zooms the page in when a form control smaller than 16 px takes
    // focus, which makes the layout wider than the screen and pannable sideways — the exact shape
    // of "slightly too wide … horizontal scroll", and the one the owner reported on the settings
    // screen ("i think the dropdown option could be causing some overflow"). The zoom lives in
    // `visualViewport.scale` and leaves `documentElement.scrollWidth` untouched, so a width-only
    // audit reports that screen clean while the owner is panning it. Hence a *focus* reading.
    queue('Library — the search field focused, holding a long unbroken query', function () {
      return setHash('#/artists', "document.querySelectorAll('.row').length > 0", 'the artist list');
    }, function () {
      return focusProbe('.page-head .field', 'バラードのなかのいちばん長いタイトルをここに入れる'.repeat(2));
    });
    queue('Artist (#/artist/artist-ja) — long Japanese album names in the grid', function () {
      return setHash('#/artist/artist-ja', "document.querySelectorAll('.card').length > 0", 'the stress artist');
    });
    queue('Album (#/album/album-ja-1) — long Japanese and unbroken-Latin track titles', function () {
      return setHash('#/album/album-ja-1', "document.querySelectorAll('.row.song').length > 0", 'the stress album');
    });
    queue('Album — the "Add to playlist" dropdown focused', function () {
      return setHash('#/album/album-ja-1', "document.querySelectorAll('.row.song').length > 0", 'the stress album');
    }, function () {
      return focusProbe('.detail-text select');
    });
    queue('Playlists (#/playlists) — two very long playlist names', function () {
      return setHash('#/playlists', "document.querySelectorAll('.row').length > 2", 'the playlist list');
    });
    queue('Playlists — a very long playlist name typed into the field and focused', function () {
      return setHash('#/playlists', "document.querySelectorAll('.row').length > 2", 'the playlist list');
    }, function () {
      return focusProbe('.page-head .field', 'A playlist name long enough to push any field wider than the screen'.repeat(2));
    });
    queue('Playlist (#/playlist/pl-stress-ja) — long Japanese playlist name', function () {
      return setHash('#/playlist/pl-stress-ja', "document.querySelectorAll('.row.song').length > 0", 'the stress playlist');
    });
    queue('Settings (#/settings) — the long playback-preference select', function () {
      return setHash('#/settings', "document.querySelector('select') !== null", 'settings');
    });
    // The owner's own screen, in the state he reported it in: the playback dropdown, focused —
    // which is the moment iOS decides whether to zoom.
    queue('Settings — the playback dropdown focused (the screen the owner reported)', function () {
      return setHash('#/settings', "document.querySelector('select') !== null", 'settings');
    }, function () {
      return focusProbe('select.field');
    });
    queue('Changelog (#/changelog)', function () {
      return setHash('#/changelog', "document.querySelector('.release') !== null", 'the changelog');
    });
    // The connect screen is a route, so it is walked like one. It used to be missing from this
    // walk: `#/connect` is reachable while a session is live (the queue keeps playing), and it is
    // the screen with the longest text in a field (the server address).
    queue('Connect (#/connect) — the server address field holding a long address, focused', function () {
      return setHash('#/connect', "document.querySelector('.connect .field') !== null", 'the connect form');
    }, function () {
      return focusProbe('.connect .field', 'https://alienlab.tailbed832.ts.net:9443/navidrome/very/long/path');
    });
    queue('Now (#/now, spectrum) — long title, long "Playing from" line', function () {
      return setHash('#/playlist/pl-stress-ja', "document.querySelectorAll('.row.song').length > 0", 'the stress playlist again').then(function () {
        // The app's own tap target. v1.5 made the whole row one, so `playRow` uses the row.
        playRow(0);
        return waitFor("location.hash === '#/now'", 'the now-playing screen').then(function () {
          return waitFor("Boolean(document.querySelector('.now-canvas'))", 'the spectrum canvas');
        }).then(settlePager).then(function () {
          return new Promise(function (resolve) {
            setTimeout(resolve, 600); // let a frame or two of the visualiser land
          });
        });
      });
    });
    queue('Now (#/now, lyrics) — long unbroken Japanese lyric lines', function () {
      return setHash('#/playlist/pl-stress-ja', "document.querySelectorAll('.row.song').length > 0", 'the stress playlist again').then(function () {
        playRow(0);
        return waitFor("location.hash === '#/now'", 'the now-playing screen').then(settlePager);
      }).then(function () {
        var pills = document.querySelectorAll('.pill-option');
        if (pills.length < 2) throw new Error('no lyrics pill');
        pills[1].click();
        return waitForMode('lyrics').then(function () {
          return waitFor("document.querySelectorAll('.lyric-line').length > 0", 'the lyric lines');
        }).then(function () {
          return new Promise(function (resolve) {
            setTimeout(resolve, 250);
          });
        });
      });
    }, lyricsDensity);
    queue('Now (#/now, lyrics) — mid-swipe, finger down and moved', function () {
      beginSwipe('.now');
      return new Promise(function (resolve) {
        setTimeout(resolve, 120);
      });
    }, lyricsDensity);
    queue('Now (#/now, lyrics) — after the swipe completes', function () {
      endSwipe('.now');
      return new Promise(function (resolve) {
        setTimeout(resolve, 500);
      });
    }, lyricsDensity);
    /*
     * Back to browsing with a track playing: the mini player bar is only visible off the now
     * screen, so this is the *only* state in which its long title, its long album line and the
     * mode chip share one non-wrapping grid row. The bar was never measured with long content
     * until this step existed.
     */
    queue('Library with the player bar showing a long Japanese title', function () {
      return setHash('#/artists', "document.querySelectorAll('.row').length > 0", 'the artist list').then(function () {
        return new Promise(function (resolve) {
          setTimeout(resolve, 500);
        });
      });
    });
    queue('Stress album with the player bar showing a long unbroken Latin title', function () {
      return setHash('#/album/album-ja-1', "document.querySelectorAll('.row.song').length > 0", 'the stress album').then(function () {
        var rows = document.querySelectorAll('.row.song .row-play');
        if (rows.length > 2) rows[2].click();
        return waitFor("location.hash === '#/now'", 'the now screen').then(function () {
          return setHash('#/album/album-ja-1', "document.querySelectorAll('.row.song').length > 0", 'the stress album again');
        });
      });
    });

    return chain.then(function () {
      return {
        device: DEVICE,
        environment: environment(),
        results: results,
      };
    });
  }

  /**
   * Silence the *audio* without touching the transport.
   *
   * The engine builds its media element with `new Audio()` and never appends it to the document,
   * so no harness can reach it by selector. `captureMediaElement()` below wraps the constructor
   * before the app's bundle runs and keeps the element; setting its volume to zero makes the
   * analyser report silence while the element is still playing — which is the only way to hold
   * the screen in *spectrum* mode and ask what a silent spectrum frame looks like. Pausing would
   * flip the screen to the album-art theme and prove nothing about the bars.
   */
  function silenceAudio() {
    var element = window.__naviliteMediaElement;
    if (!element) return null;
    element.volume = 0;
    return {
      volume: element.volume,
      paused: element.paused,
      currentTime: Math.round(element.currentTime * 1000) / 1000,
    };
  }

  /**
   * Seek the real media element — what the owner does by dragging the progress bar.
   *
   * This is the only honest way to make the app light a given lyric line: the highlight is driven by
   * the app's own progress path (`renderProgress` calls `lyrics.position()`), so a line that lights
   * here is a line that lights for him, whether the position came from playing or from seeking.
   */
  function seekAudio(seconds) {
    var element = window.__naviliteMediaElement;
    if (!element || !isFinite(element.duration)) return null;
    element.currentTime = Math.max(0, Math.min(element.duration - 0.05, Number(seconds)));
    return audioState();
  }

  /** Where the real element is: the harness derives the sidecar's own timings from this. */
  function audioState() {
    var element = window.__naviliteMediaElement;
    if (!element) return null;
    return {
      currentTime: element.currentTime,
      duration: element.duration,
      paused: element.paused,
      readyState: element.readyState,
    };
  }

  /**
   * Pause the real element.
   *
   * A track that is left to run to its end has the app roll onto the next one, which re-renders the
   * now screen and disturbs whatever the check was in the middle of. Pausing first keeps a seek to
   * the last line a seek to the last line.
   */
  function pauseAudio() {
    var element = window.__naviliteMediaElement;
    if (!element) return null;
    element.pause();
    return audioState();
  }

  /**
   * A flick, timed *inside* the page.
   *
   * The pager reads its release velocity from the `performance.now()` gaps between touchmoves. Every
   * other gesture here goes through the input pipeline, which costs a round trip per move — a hundred
   * times a finger's cadence — so a "fast" gesture driven that way measures up as a slow one and the
   * velocity projection can never be reached. This drives the same listeners with `TouchEvent`s at a
   * finger's pace (26 px every 8 ms) and records the offset after each move, so a commit here cannot
   * be anything but the projection: the distance travelled is the same shallow one the slow check
   * snaps back from.
   */
  function flickPager(options) {
    var target = document.querySelector(options.selector || '.now-visualizer');
    if (!target || typeof Touch !== 'function' || typeof TouchEvent !== 'function') return Promise.resolve(null);
    var fromX = options.fromX;
    var toX = options.toX;
    var steps = options.steps || 3;
    var gapMs = options.gapMs || 8;
    var y = options.y || Math.round(window.innerHeight / 2);
    var identifier = 7;
    var make = function (x) {
      return new Touch({ identifier: identifier, target: target, clientX: Math.round(x), clientY: y });
    };
    var fire = function (type, x) {
      var point = make(x);
      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === 'touchend' ? [] : [point],
          targetTouches: type === 'touchend' ? [] : [point],
          changedTouches: [point],
        }),
      );
    };
    var offsets = [];
    return new Promise(function (resolve) {
      var started = performance.now();
      fire('touchstart', fromX);
      var send = function (index) {
        if (index > steps) {
          fire('touchend', toX);
          resolve({ ms: Math.round(performance.now() - started), offsets: offsets });
          return;
        }
        var x = fromX + ((toX - fromX) * index) / steps;
        setTimeout(function () {
          fire('touchmove', x);
          var state = pagerState();
          if (state) offsets.push(state.offset);
          send(index + 1);
        }, gapMs);
      };
      send(1);
    });
  }

  function captureMediaElement() {
    if (typeof window.Audio !== 'function' || window.__naviliteMediaElement) return;
    var Original = window.Audio;
    var Wrapper = function () {
      var element = new Original();
      window.__naviliteMediaElement = element;
      return element;
    };
    Wrapper.prototype = Original.prototype;
    window.Audio = Wrapper;
  }

  captureMediaElement();

  /* ---------------------------------------------------- scroll containment (v1.4) */

  /**
   * The owner's two v1.4 reports are both about *what moves when he scrolls*:
   *
   *   "if i'm in my playlist then i go to my spectrum view, when i scroll, it seems to scroll the
   *    playlist behind it."
   *   "i should not be able to scroll the top bar of the main app such that it takes up more space"
   *
   * So the evidence has to be positions, not intentions: where the list is, where the document is,
   * and where the top bar is — before a scroll gesture, while the spectrum covers the list, and
   * after coming back. Everything below is a measurement; the comparing is the driver's job
   * (tools/scroll-check.mjs for Chrome, the device-probe bootstrap for a real iPhone).
   *
   * `scrollContainment()` is the whole scenario self-driven, because the WebKit run has no CDP to
   * fire a real gesture at it. Chrome's driver composes the same steps around real scroll gestures.
   */

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * Frames, because a scroll is not applied in the same task it is asked for.
   *
   * Each frame carries a timer backstop. `requestAnimationFrame` stops for a tab Safari does not
   * consider visible — the simulator's browser is in that state whenever the Simulator window is
   * behind something else — and a probe that is *walking the app* must not hang for minutes on a
   * window nobody is looking at. Layout and computed styles still update for an occluded tab;
   * these readings only need the scroll to have been applied, which the timer guarantees.
   */
  function nextFrames(count) {
    var left = count || 2;
    return new Promise(function (resolve) {
      var settled = false;
      var settle = function () {
        if (settled) return;
        settled = true;
        resolve(true);
      };
      var backstop = setTimeout(settle, 200 * left);
      requestAnimationFrame(function tick() {
        left -= 1;
        if (left <= 0) {
          clearTimeout(backstop);
          settle();
        } else requestAnimationFrame(tick);
      });
    });
  }

  function headerRect() {
    var header = document.querySelector('.topbar');
    if (!header) return null;
    var rect = header.getBoundingClientRect();
    return { top: round2(rect.top), height: round2(rect.height), bottom: round2(rect.bottom) };
  }

  /** One reading of everything the containment checks compare. */
  function scrollState() {
    var s = scrollSurfaces();
    var scrollerStyle = s.scroller ? getComputedStyle(s.scroller) : null;
    var nowStyle = s.now ? getComputedStyle(s.now) : null;
    var lyricsStyle = s.lyrics ? getComputedStyle(s.lyrics) : null;
    var status = null;
    try {
      status = window.__navilite ? window.__navilite.status() : null;
    } catch (error) {
      status = null;
    }
    return {
      route: location.hash,
      header: headerRect(),
      headerPosition: s.header ? getComputedStyle(s.header).position : null,
      // The document is not supposed to be a scroller at all any more.
      documentScrollTop: s.document ? round2(s.document.scrollTop) : null,
      windowScrollY: round2(window.scrollY),
      documentScrollable: scrollableBy(s.document),
      // The one box that scrolls the app's content.
      scrollSurface: selectorFor(s.scroller),
      scrollTop: round2(s.scroller.scrollTop),
      scrollable: scrollableBy(s.scroller),
      overflowY: scrollerStyle ? scrollerStyle.overflowY : null,
      overscrollY: scrollerStyle ? scrollerStyle.overscrollBehaviorY : null,
      nowOpen: s.now ? !s.now.classList.contains('hidden') : false,
      nowOverscroll: nowStyle ? nowStyle.overscrollBehavior : null,
      nowTouchAction: nowStyle ? nowStyle.touchAction : null,
      lyricsScrollTop: s.lyrics ? round2(s.lyrics.scrollTop) : null,
      lyricsScrollable: scrollableBy(s.lyrics),
      lyricsOverscrollY: lyricsStyle ? lyricsStyle.overscrollBehaviorY : null,
      // The (x/y) line and the transport, which have to keep working behind/on the overlay.
      context: (document.querySelector('.now-context') || {}).textContent || null,
      engineState: status ? status.state : null,
      spectrumChip: (document.querySelector('.mode-chip') || {}).textContent || null,
    };
  }

  /**
   * Which element a finger would actually land on, over a grid of the screen. This is the
   * engine-honest way to say "the list underneath cannot be reached": not "the CSS looks right",
   * but "hit-testing the whole screen returns the overlay".
   *
   * The grid is laid out from the *live* viewport, not from the device constant: Safari on a phone
   * gives the page a shorter layout viewport than the screen (the URL bar), and a point below it
   * has no element at all — `elementFromPoint` answers null, which is not evidence that anything
   * leaked through. Those points are reported as `outsideViewport` and left out of the verdict.
   */
  function hitTest() {
    var width = window.innerWidth || DEVICE.width;
    var height = window.innerHeight || DEVICE.height;
    var fractions = [0.11, 0.29, 0.49, 0.7, 0.93];
    var columns = [0.1, 0.31, 0.51, 0.71, 0.92];
    var points = [];
    for (var r = 0; r < fractions.length; r += 1) {
      for (var c = 0; c < columns.length; c += 1) {
        var x = Math.round(width * columns[c]);
        var y = Math.round(height * fractions[r]);
        var el = document.elementFromPoint(x, y);
        var inside = !!(el && el.closest && el.closest('.now'));
        points.push({
          x: x,
          y: y,
          selector: el ? selectorFor(el) : null,
          insideNow: inside,
          outsideViewport: !el,
        });
      }
    }
    var insideViewport = points.filter(function (point) {
      return !point.outsideViewport;
    });
    return {
      points: points,
      width: width,
      height: height,
      allInsideNow: insideViewport.every(function (point) {
        return point.insideNow;
      }),
    };
  }

  /**
   * Open a list that really scrolls, and put it at a known offset.
   *
   * The offset is set on whatever box scrolls the app's content. Before v1.4 that box was the
   * document itself — which is the defect this measures, so the reading is taken wherever the
   * scroll actually goes rather than where it ought to.
   */
  function prepareScroll(options) {
    var settings = options || {};
    var hash = settings.hash || '#/playlist/pl-stress-long';
    var offset = typeof settings.offset === 'number' ? settings.offset : 400;
    return setHash(hash, "document.querySelectorAll('.row.song').length > 4", 'the long playlist')
      .then(function () {
        var scroller = scrollSurfaces().scroller;
        var room = scrollableBy(scroller);
        if (room < 100) {
          throw new Error('nothing to scroll: ' + selectorFor(scroller) + ' has only ' + room + ' px of scrollable content');
        }
        scroller.scrollTop = Math.min(room, offset);
        return nextFrames(2);
      })
      .then(function () {
        var state = scrollState();
        if (state.scrollTop < 1) throw new Error('the list would not scroll (scrollTop ' + state.scrollTop + ')');
        return state;
      });
  }

  /** The app's own route onto the now screen: tap a row, as a person does. */
  function openNowFromList() {
    var rows = document.querySelectorAll('.row.song');
    if (rows.length === 0) return Promise.reject(new Error('no playable row on this screen'));
    playRow(0);
    return waitFor("location.hash === '#/now'", 'the now screen')
      // The spectrum pane, not merely "the pager has stopped": the hashchange that opens it is a
      // later task, so this is the wait that makes the reading a screen at rest (see settlePager).
      .then(function () {
        return settlePager(1);
      })
      .then(function () {
        return nextFrames(2);
      })
      .then(scrollState);
  }

  /**
   * Everything a *viewer* can reach while the spectrum is up: the window, and the document. The
   * list behind the overlay is not in that set — the overlay covers the screen and the box
   * underneath is frozen — which is exactly what the Chrome driver's real gestures confirm, and
   * what `hitTest()` measures on a device where no gesture can be synthesised.
   */
  function attemptViewerScroll() {
    var s = scrollSurfaces();
    var before = round2(s.scroller.scrollTop);
    window.scrollTo(0, 600);
    if (s.document) s.document.scrollTop = 600;
    if (s.view) s.view.scrollTop = s.view.scrollTop + 600;
    if (s.lyrics) s.lyrics.scrollTop = s.lyrics.scrollTop + 400;
    return nextFrames(3).then(function () {
      var state = scrollState();
      return { moved: round2(s.scroller.scrollTop) - before, state: state };
    });
  }

  /**
   * A programmatic poke at the frozen container itself.
   *
   * Not something a finger can do — the overlay is over it — but an `overflow: hidden` box is still
   * scrollable programmatically, so this is the harshest form of "the list underneath was moved
   * while the spectrum was open": the offset has to come back exactly when the spectrum closes, and
   * that is what the last step of the scenario checks.
   */
  function pokeFrozenList(by) {
    var scroller = scrollSurfaces().scroller;
    var before = round2(scroller.scrollTop);
    scroller.scrollTop = scroller.scrollTop + (typeof by === 'number' ? by : 600);
    return nextFrames(2).then(function () {
      return { moved: round2(scroller.scrollTop) - before, state: scrollState() };
    });
  }

  /** `#/playlists` through the app's own close button, which is the "going back" he described. */
  function closeNow() {
    var close = document.querySelector('.now-close');
    if (!close) return Promise.reject(new Error('no close button on the now screen'));
    close.click();
    return waitFor("location.hash !== '#/now'", 'the browse screen')
      .then(function () {
        return settlePager(0);
      })
      .then(function () {
        return waitFor("document.querySelectorAll('.row.song').length > 4", 'the list again');
      })
      .then(function () {
        return nextFrames(3);
      })
      .then(scrollState);
  }

  /**
   * One finger swipe across the now screen, at real geometry: down near one edge, moved across,
   * lifted near the other. Each move is dispatched separately, so the pager sees a drag with a
   * direction and a velocity rather than a single jump.
   */
  function swipePager(direction) {
    var target = document.querySelector('.now');
    if (!target || typeof Touch !== 'function') {
      // No now screen to swipe (a build that has closed it already, say).
      return Promise.resolve(null);
    }
    var width = window.innerWidth || DEVICE.width;
    var y = Math.round((window.innerHeight || DEVICE.height) / 2);
    var from = direction === 'left' ? width - 40 : 40;
    var to = direction === 'left' ? 40 : width - 40;
    var point = function (x) {
      return new Touch({ identifier: 7, target: target, clientX: Math.round(x), clientY: y });
    };
    var fire = function (type, x, touches) {
      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: touches,
          targetTouches: touches,
          changedTouches: [point(x)],
        }),
      );
    };
    fire('touchstart', from, [point(from)]);
    for (var step = 1; step <= 5; step += 1) {
      var x = from + ((to - from) * step) / 5;
      fire('touchmove', x, [point(x)]);
    }
    fire('touchend', to, []);
    return settlePager();
  }

  /**
   * Swipe left until the playlist is on screen.
   *
   * v1.5 made the now screen a three-pane pager — playlist | spectrum | lyrics — so one left swipe
   * from the spectrum lands on the lyrics and a second one lands on the playlist. This walks that
   * route with real swipes and reports how many it took, which is the transition the owner asked
   * for stated as a measurement rather than as an intention.
   */
  function swipeLeftToPlaylists() {
    var attempts = 0;
    var firstPane = null;
    var panes = [];
    var advance = function () {
      if (attempts >= 3) return Promise.resolve();
      attempts += 1;
      return swipePager('left').then(function (state) {
        var pane = state ? state.position : null;
        panes.push(pane);
        if (firstPane === null) firstPane = pane;
        if (location.hash.indexOf('#/playlist') === 0) return;
        return advance();
      });
    };
    return advance()
      .then(function () {
        return nextFrames(2);
      })
      .then(function () {
        return { route: location.hash, swipes: attempts, panes: panes, firstPane: firstPane, state: scrollState() };
      });
  }

  /** The (x/y) line, the transport and the Spectrum/Lyrics pill, while the overlay is up. */
  function overlayControlsCheck() {
    var result = {};
    var pills = document.querySelectorAll('.pill-option');
    if (pills.length < 2) return Promise.reject(new Error('the spectrum/lyrics pill is missing'));
    var empty = scrollState();
    result.context = empty.context;
    result.engineState = empty.engineState;
    result.transport = document.querySelectorAll('.now-bar .transport').length;
    result.pagerBefore = pagerState();
    pills[1].click();
    return waitForMode('lyrics')
      .then(function () {
        result.lyricsMode = true;
        return nextFrames(2);
      })
      .then(function () {
        pills[0].click();
        return waitForMode('spectrum');
      })
      .then(function () {
        result.spectrumMode = true;
        result.mode = window.__navilite ? window.__navilite.nowMode() : null;
        result.pagerAfter = pagerState();
        return result;
      });
  }

  /** Set the Spectrum/Lyrics pill by index, without the mode-switch assertions. */
  function setPillMode(index) {
    var pills = document.querySelectorAll('.pill-option');
    if (pills.length < 2) return Promise.reject(new Error('no pill to click'));
    pills[index].click();
    return waitForMode(index === 1 ? 'lyrics' : 'spectrum')
      .then(function () {
        return nextFrames(2);
      })
      .then(scrollState);
  }

  /**
   * The whole scenario, self-driven: list scrolled → spectrum open → everything a viewer can reach
   * asked to scroll → the frozen container poked → close → the list is where it was. Returns the
   * readings *and* the verdict, so the WebKit run can post one object and have it mean something.
   */
  function scrollContainment(options) {
    var report = { steps: [] };
    var opened = null;
    var attempts = [];
    var record = function (label, state) {
      report.steps.push({ label: label, state: state });
      return state;
    };
    return prepareScroll(options || {})
      .then(function (state) {
        opened = state;
        record('the list, scrolled before the spectrum was opened', state);
      })
      .then(openNowFromList)
      .then(function (state) {
        record('the spectrum, opened over the list', state);
      })
      .then(function () {
        report.hitTest = hitTest();
        return attemptViewerScroll();
      })
      .then(function (attempt) {
        attempts.push(attempt.state);
        record('after asking the window and the document to scroll', attempt.state);
      })
      .then(overlayControlsCheck)
      .then(function (controls) {
        report.controls = controls;
      })
      .then(function () {
        // In lyrics mode the overlay owns a scroller of its own; its chaining is the same question.
        return setPillMode(1);
      })
      .then(function (state) {
        record('lyrics mode, before asking it to scroll', state);
        return attemptViewerScroll();
      })
      .then(function (attempt) {
        attempts.push(attempt.state);
        record('after asking the window and the document to scroll (lyrics mode)', attempt.state);
      })
      .then(function () {
        return pokeFrozenList(600);
      })
      .then(function (poked) {
        report.programmatic = { moved: poked.moved };
        record('after scrolling the frozen container itself, programmatically', poked.state);
      })
      .then(function () {
        return setPillMode(0);
      })
      .then(closeNow)
      .then(function (state) {
        record('the list, after closing the spectrum', state);
        report.before = opened;
        report.after = state;
        report.headerUnchanged = JSON.stringify(state.header) === JSON.stringify(opened.header);
        report.listRestored = state.scrollTop === opened.scrollTop;
        report.documentNeverScrolled = report.steps.every(function (step) {
          return step.state.documentScrollTop === 0 && step.state.windowScrollY === 0;
        });
        report.headerNeverMoved = report.steps.every(function (step) {
          return JSON.stringify(step.state.header) === JSON.stringify(opened.header);
        });
        report.listNeverMoved = attempts.every(function (state) {
          return state.scrollTop === opened.scrollTop;
        });
        report.documentFrozen = report.steps.every(function (step) {
          return step.state.documentScrollable === 0;
        });
      })
      .then(openNowFromList)
      .then(swipeLeftToPlaylists)
      .then(function (swiped) {
        report.swipe = swiped;
      })
      .then(function () {
        report.pager = pagerState();
        report.checks = {
          documentFrozen: report.documentFrozen,
          documentNeverScrolled: report.documentNeverScrolled,
          headerNeverMoved: report.headerNeverMoved,
          listNeverMoved: report.listNeverMoved,
          listRestored: report.listRestored,
          overlayIsTheOnlyHitTarget: report.hitTest.allInsideNow,
          /*
           * v1.5. The swipe no longer closes the screen outright: it moves the pager one pane, so
           * the same gesture now walks spectrum -> lyrics -> the playlist he was on. Both halves are
           * checked, because "the swipe does something" would be satisfied by the old behaviour too.
           */
          swipeLandsOnThePlaylist: String(report.swipe.route).indexOf('#/playlist') === 0,
          swipeStepsThroughThePanes: report.swipe.firstPane === null || report.swipe.firstPane === 2,
          controlsStillWork: report.controls.transport === 5 && report.controls.mode === 'spectrum'
            && /^Playing from .+\(\d+\/\d+\)$/.test(String(report.controls.context)),
          pagerSettledOnTheSpectrum: report.pager === null || report.pager.position === 1,
        };
        report.passed = Object.keys(report.checks).every(function (key) {
          return report.checks[key] === true;
        });
        return report;
      });
  }

  window.__naviliteLayoutAudit = {
    DEVICE: DEVICE,
    environment: environment,
    measure: measure,
    viewportState: viewportState,
    focusProbe: focusProbe,
    lyricsDensity: lyricsDensity,
    spectrumSnapshot: spectrumSnapshot,
    silenceAudio: silenceAudio,
    waitFor: waitFor,
    walk: walk,
    // v1.4: the scroll-containment readings and the self-driven scenario.
    scrollState: scrollState,
    scrollSurfaces: scrollSurfaces,
    headerRect: headerRect,
    hitTest: hitTest,
    prepareScroll: prepareScroll,
    openNowFromList: openNowFromList,
    closeNow: closeNow,
    swipeLeftToPlaylists: swipeLeftToPlaylists,
    overlayControlsCheck: overlayControlsCheck,
    setPillMode: setPillMode,
    attemptViewerScroll: attemptViewerScroll,
    pokeFrozenList: pokeFrozenList,
    scrollContainment: scrollContainment,
    // v1.5: the pager, and the app's own tap target for a row.
    pagerState: pagerState,
    settlePager: settlePager,
    waitForPane: waitForPane,
    waitForMode: waitForMode,
    swipePager: swipePager,
    playRow: playRow,
    songRowCount: songRowCount,
    // v1.5: the pager's own geometry and the two readings its checks are made of.
    nowGeometry: nowGeometry,
    controlHitTest: controlHitTest,
    lyricsFollowState: lyricsFollowState,
    seekAudio: seekAudio,
    audioState: audioState,
    pauseAudio: pauseAudio,
    flickPager: flickPager,
  };
})();
