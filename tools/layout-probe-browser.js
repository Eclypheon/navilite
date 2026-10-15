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

  /**
   * Can the surface actually be dragged sideways, and by how much?
   *
   * v1.5 follow-up. A `scrollWidth` larger than a `clientWidth` is a *claim* that there is
   * something to scroll; what the owner can do with his finger is the test. An element with a
   * scrollable overflow region is scrollable by pointer, by touch and by script, so pushing it and
   * reading where it landed is the reading that says "draggable" without an assumption. `overflowX`
   * comes with it, because `hidden` and `clip` are the two values that put a box out of a finger's
   * reach, and only the second one also takes it out of a script's.
   */
  function surfaceSideScroll(surface) {
    var box = surface || scrollSurfaces().scroller;
    if (!box) return null;
    var style = getComputedStyle(box);
    var before = box.scrollLeft;
    box.scrollLeft = 9999;
    var reached = box.scrollLeft;
    box.scrollLeft = before;
    return {
      selector: selectorFor(box),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      clientWidth: box.clientWidth,
      scrollWidth: box.scrollWidth,
      /** How far a push actually moved it, in px: 0 means there is nothing to scroll. */
      sideScroll: round2(reached),
      restoredTo: round2(box.scrollLeft),
    };
  }

  /**
   * The settings screen's 301 px, taken apart.
   *
   * The v1.5 run measured the settings scroll surface at `393 -> 694 px` with the playback dropdown
   * focused, named no element, and left it open. `widestWhileFocused` names the element the width
   * comes from; this goes one step further and *tests candidates in the shipping engine, in one
   * run*: each rule is applied to the live page, the surface is re-measured and pushed sideways, and
   * the rule is removed again — so the answer is a measurement rather than a belief about what
   * WebKit does with a `<select>` whose content is wider than its box.
   *
   * The option labels are measured with a hidden ruler at the select's own font, because "the
   * longest option is 671 px of text" is the other half of the story and it is checkable.
   */
  function settingsOverflowProbe(candidates) {
    var select = document.querySelector('select.field');
    var surface = scrollSurfaces().scroller;
    if (!select || !surface) {
      return Promise.reject(new Error('no playback select or no scroll surface to measure'));
    }
    var style = document.createElement('style');
    style.setAttribute('data-probe', 'settings-overflow');
    document.head.appendChild(style);

    var sample = function () {
      // Force layout, then read the surface, its widest descendant, and its real side-scroll.
      void surface.offsetWidth;
      return {
        surfaceOverflow: horizontalOverflowOf(surface),
        widest: widestInsideSurface(),
        sideScroll: surfaceSideScroll(surface),
      };
    };

    var baseline = sample();
    var rules = candidates || [
      { label: 'baseline (the shipping CSS)', css: '' },
      {
        label: 'the pre-fix control: select.field { overflow: visible }',
        css: 'select.field { overflow: visible; }',
        control: true,
      },
      { label: 'select.field { overflow: hidden }', css: 'select.field { overflow: hidden; }' },
      { label: 'select.field { overflow-x: hidden }', css: 'select.field { overflow-x: hidden; }' },
      {
        label: 'select.field { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }',
        css: 'select.field { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      },
      { label: 'select.field { contain: inline-size }', css: 'select.field { contain: inline-size; }' },
      { label: 'select.field { appearance: none }', css: 'select.field { appearance: none; }' },
      { label: '.field.inline { width: 100% }', css: '.field.inline { width: 100%; }' },
      { label: '.view-scroll { overflow-x: hidden }', css: '.view-scroll { overflow-x: hidden; }' },
      { label: '.view-scroll { overflow-x: clip }', css: '.view-scroll { overflow-x: clip; }' },
      {
        label: 'the two together: select.field { overflow: hidden } + .view-scroll { overflow-x: hidden }',
        css: 'select.field { overflow: hidden; } .view-scroll { overflow-x: hidden; }',
      },
    ];
    var results = [];
    for (var i = 0; i < rules.length; i += 1) {
      style.textContent = rules[i].css;
      var reading = sample();
      results.push({
        label: rules[i].label,
        css: rules[i].css || null,
        control: rules[i].control === true,
        surfaceOverflow: reading.surfaceOverflow,
        widest: reading.widest ? reading.widest.selector + ' (+' + reading.widest.overflow + ' px)' : null,
        sideScroll: reading.sideScroll,
      });
    }
    style.textContent = '';
    var restored = sample();
    style.remove();

    /* The labels themselves: a ruler at the select's own font, so the widest option is a number. */
    var computed = getComputedStyle(select);
    var ruler = document.createElement('span');
    ruler.setAttribute('aria-hidden', 'true');
    ruler.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;';
    ruler.style.fontFamily = computed.fontFamily;
    ruler.style.fontSize = computed.fontSize;
    ruler.style.fontWeight = computed.fontWeight;
    ruler.style.fontStyle = computed.fontStyle;
    ruler.style.letterSpacing = computed.letterSpacing;
    document.body.appendChild(ruler);
    var options = [];
    for (var oi = 0; oi < select.options.length; oi += 1) {
      ruler.textContent = select.options[oi].textContent || '';
      options.push({
        index: oi,
        selected: select.options[oi].selected,
        width: round2(ruler.getBoundingClientRect().width),
        text: (select.options[oi].textContent || '').slice(0, 60),
      });
    }
    ruler.remove();

    return Promise.resolve({
      fontSize: computed.fontSize,
      select: {
        selector: 'select.field',
        clientWidth: select.clientWidth,
        scrollWidth: select.scrollWidth,
        rectWidth: round2(select.getBoundingClientRect().width),
        overflow: horizontalOverflowOf(select),
      },
      options: options,
      baseline: baseline,
      candidates: results,
      /** The same reading with every rule removed: a candidate that only "worked" because the page
       * was left in a changed state shows up here. */
      restored: restored,
      restoredMatchesBaseline: restored.surfaceOverflow === baseline.surfaceOverflow,
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
      /**
       * v1.7.1: the seek bar's own box, so a harness can put a finger on it by geometry rather than
       * by selector — a slider is dragged, not clicked, and where the drag starts is what decides
       * whether the pager gets the gesture.
       */
      progress: box('.now-progress .progress'),
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
   * this is the number of lit pixels and a checksum over every byte of the canvas. The driver owns
   * the frames and the silence (see tools/spectrum-proof.mjs) — this only reads.
   *
   * `withShape` adds two more facts about the same reading, because the picture also has a *shape*:
   *
   *   - `belowBaseline` — lit pixels under the bars' own baseline (`BASELINE`, 0.98 of the canvas
   *     height, in `src/player/visualizer.ts`). Nothing is drawn there: a lit pixel below it is a
   *     second copy of a bar (v1.1's reflection) rather than a bar.
   *   - `columnsWithMoreThanOneRun` and `worstRunsInAColumn` — per canvas column, how many
   *     *separated* vertical runs of lit pixels it holds. One flat rectangle per band is one run; a
   *     cap floating above the bar, or a reflection under it, is another. Runs are used rather than
   *     distinct colours because a bar's bottom edge lands on the baseline line, which is fractional
   *     on most canvas heights: one antialiased row then blends the bar colour with the backdrop at
   *     two different alphas, which is two colours in one column on a perfectly ordinary frame.
   *     Separated runs have no such ambiguity — a gap in the column is a gap.
   *
   * They cost a pass over the canvas, so they are opt-in: the frame-by-frame readings
   * `tools/layout-audit.mjs` takes call this with no argument and pay what they always paid.
   */
  function spectrumSnapshot(withShape) {
    var canvas = document.querySelector('.now-canvas');
    if (!canvas || !canvas.width) return null;
    var c = canvas.getContext('2d');
    if (!c) return null;
    var data = c.getImageData(0, 0, canvas.width, canvas.height).data;
    var width = canvas.width;
    var height = canvas.height;
    var lit = 0;
    var sum = 0;
    var belowBaseline = 0;
    /*
     * The first row that no bar may paint. A bar's bottom edge *is* the baseline line, so the row
     * holding it is legitimate; the line is fractional on most canvas heights (0.98 × 178 = 174.44),
     * and then the bar also paints the first row *under* the line with partial coverage — so the
     * first row that has to be clear is one past the line's own row, not one past its floor.
     */
    var firstClearRow = Math.floor(height * 0.98) + 2;
    for (var i = 0; i < data.length; i += 4) {
      // The bars are the palette colour over a near-black backdrop: anything clearly lit is a
      // bar (or an artefact pretending to be one).
      if (data[i + 3] > 8 && data[i] + data[i + 1] + data[i + 2] > 240) {
        lit += 1;
        if (withShape && Math.floor(i / 4 / width) + 1 >= firstClearRow) belowBaseline += 1;
      }
      sum = (sum * 31 + data[i] * 7 + data[i + 1] * 3 + data[i + 2] * 11 + data[i + 3]) % 2147483647;
    }
    var multiRun = 0;
    var worstRuns = 0;
    if (withShape) {
      for (var x = 0; x < width; x += 1) {
        var runs = 0;
        var inRun = false;
        for (var y = 0; y < height; y += 1) {
          var at = (y * width + x) * 4;
          var isLit = data[at + 3] > 8 && data[at] + data[at + 1] + data[at + 2] > 240;
          if (isLit && !inRun) runs += 1;
          inRun = isLit;
        }
        if (runs > worstRuns) worstRuns = runs;
        if (runs > 1) multiRun += 1;
      }
    }
    return {
      lit: lit,
      checksum: sum,
      canvas: canvas.width + 'x' + canvas.height,
      bytes: data.length,
      belowBaseline: withShape ? belowBaseline : undefined,
      columnsWithMoreThanOneRun: withShape ? multiRun : undefined,
      worstRunsInAColumn: withShape ? worstRuns : undefined,
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

  /**
   * The native spectrum and the clock, in the shipping engine, on the device (v1.7.2).
   *
   * Everything else in this file runs in a browser, where the audio engine is the `<audio>` element
   * and the analyser. The paths that matter for the owner's report — the native player, the tap on
   * it, and the return from the background — only exist in the wrapped build, so this scenario is
   * run from the *app* in the simulator (`tools/device-probe.mjs --app … --native-audio …`).
   *
   * What it reads, in the order the owner described it:
   *
   *   (a) select a song, then read the position 250 ms later — the clock must have moved (his
   *       complaint was *"when initially selecting the song, it is stuck at 0:00"*);
   *   (b) the bands while that track plays — how many of the 64 are non-zero, how they move from
   *       frame to frame, whether any is pinned at maximum (his *"the spectrum seems to go crazy"*)
   *       and whether quiet frames read quieter;
   *   (c) a foreground round trip: the readings are taken before the app leaves the screen, the
   *       harness backgrounds and relaunches it, and the readings are taken again afterwards —
   *       from the *player's own* state, not from the UI. If no real event arrives (a run without a
   *       harness behind it) the same round trip is driven in-page, and the report says which one
   *       it was rather than implying the stronger reading.
   */
  function nativeSpectrumProbe(options) {
    var opts = options || {};
    var roundTripTimeoutMs = opts.roundTripTimeoutMs || 30000;
    var result = { startedAt: new Date().toISOString(), selection: {}, frames: [], roundTrip: {} };
    /*
     * Published as soon as it exists, and mutated in place: a probe that hangs on the platform still
     * has everything it read up to that point, and the caller can post it rather than losing the run
     * (see the watchdog in tools/device-probe.mjs's bootstrap).
     */
    nativeSpectrumProbe.lastResult = result;

    function api() {
      return window.__navilite || null;
    }

    function status() {
      var seam = api();
      return seam ? seam.status() : null;
    }

    function sleep(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    }

    function frameStats(frame) {
      if (!frame || typeof frame.length !== 'number') return null;
      var nonZero = 0;
      var pinned = 0;
      var min = Infinity;
      var max = -Infinity;
      var total = 0;
      for (var i = 0; i < frame.length; i += 1) {
        var value = frame[i];
        if (value > 0) nonZero += 1;
        if (value >= 255) pinned += 1;
        if (value < min) min = value;
        if (value > max) max = value;
        total += value;
      }
      return {
        length: frame.length,
        nonZero: nonZero,
        pinned: pinned,
        min: min === Infinity ? 0 : min,
        max: max === -Infinity ? 0 : max,
        mean: Math.round(total / frame.length),
        checksum: Math.round(total * 1000 + nonZero * 7 + max * 31),
      };
    }

    /** Never let a native call hold the report hostage: a call that never settles reads as null. */
    function withTimeout(promise, ms, fallback) {
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          resolve(fallback);
        }, ms);
        Promise.resolve(promise).then(function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }).catch(function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        });
      });
    }

    /** One reading: the app's own view, the canvas's own bands, and the tap's own counters. */
    function reading(label) {
      var state = status();
      var bands = api() && api().spectrumBands ? api().spectrumBands() : null;
      var tapCall = api() && api().nativeSpectrum ? api().nativeSpectrum() : null;
      /*
       * And the bars as drawn, off the canvas itself — the pixels, not the numbers the app says it
       * is feeding them. If the two ever disagree, the canvas is the one the owner is looking at.
       * The PNG is dropped: 10 frames of it would be megabytes of base64 through a measurement
       * channel, and the lit-pixel count plus the checksum is what compares frame to frame.
       */
      var drawn = typeof spectrumSnapshot === 'function' ? spectrumSnapshot() : null;
      return withTimeout(tapCall, 4000, null).then(function (tap) {
        return {
          label: label,
          at: Date.now(),
          state: state ? state.state : null,
          backend: state ? state.backend : null,
          reportedSpectrum: state ? state.spectrum : null,
          modeReason: state ? state.modeReason : null,
          positionMs: state ? Math.round(state.positionMs) : null,
          durationMs: state ? Math.round(state.durationMs) : null,
          bands: frameStats(bands),
          canvas: drawn ? { lit: drawn.lit, checksum: drawn.checksum, size: drawn.canvas } : null,
          tap: tap
            ? {
                live: tap.live,
                frames: tap.frames,
                silentFrames: tap.silentFrames,
                positionMs: Math.round(tap.positionMs),
                playing: tap.playing,
                readable: tap.readable,
                sampleRate: tap.sampleRate,
              }
            : null,
          tapBands: tap && tap.bands ? frameStats(tap.bands) : null,
        };
      });
    }

    var realEvents = [];
    function onVisibility() {
      realEvents.push({ hidden: document.hidden, at: Date.now() });
    }
    document.addEventListener('visibilitychange', onVisibility);

    function waitForRoundTrip() {
      var started = Date.now();
      return new Promise(function (resolve) {
        var timer = setInterval(function () {
          var hidden = realEvents.some(function (event) {
            return event.hidden;
          });
          var shownAgain = hidden && realEvents[realEvents.length - 1].hidden === false;
          if (shownAgain) {
            clearInterval(timer);
            resolve({ real: true, events: realEvents.slice(), waitedMs: Date.now() - started });
            return;
          }
          if (Date.now() - started > roundTripTimeoutMs) {
            clearInterval(timer);
            resolve({ real: false, events: realEvents.slice(), waitedMs: Date.now() - started });
          }
        }, 250);
      });
    }

    /** The in-page stand-in, for a run with no harness behind it. Reported as such. */
    function syntheticRoundTrip() {
      var descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      function setHidden(value) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return value; } });
        document.dispatchEvent(new Event('visibilitychange'));
      }
      setHidden(true);
      return sleep(2000).then(function () {
        setHidden(false);
        return sleep(600);
      }).then(function () {
        if (descriptor) Object.defineProperty(Document.prototype, 'hidden', descriptor);
        return { real: false, events: realEvents.slice(), waitedMs: 2600 };
      });
    }

    return waitFor("Boolean(window.__navilite && window.__navilite.libraryReady())", 'the library to be connected', 20000)
      .then(function () {
        // Play a stress track the way a person does: open a list, tap a row.
        location.hash = '#/album/album-ja-1';
        return waitFor("document.querySelectorAll('.row.song').length > 0", 'the stress album', 20000);
      })
      .then(function () {
        result.selection.tappedAt = Date.now();
        result.selection.target = playRow(0);
        return sleep(250);
      })
      .then(function () {
        /*
         * (a) The clock 250 ms after the selection — and the bands from the moment the engine is
         * asked, which is *before* the plugin's `start` promise can have come back. The first frame
         * that is live is the moment the bars stop being the theme, and the offset from the tap is
         * the honest number for "how long are they flat at the start of a track".
         */
        var early = [];
        return (function nextEarly(index) {
          if (index >= 5) return Promise.resolve(early);
          return reading('early-' + index).then(function (one) {
            early.push(one);
            return sleep(80).then(function () {
              return nextEarly(index + 1);
            });
          });
        })(0).then(function (taken) {
          result.early = taken;
        });
      })
      .then(function () {
        var state = status();
        result.selection.positionAfter250ms = state ? Math.round(state.positionMs) : null;
        result.selection.stateAfter250ms = state ? state.state : null;
        result.selection.backendAfter250ms = state ? state.backend : null;
        return sleep(900);
      })
      .then(function () {
        // (b) The bands, frame by frame, as the visualiser reads them.
        var reads = [];
        function next(index) {
          if (index >= 10) return Promise.resolve(reads);
          return reading('frame-' + index).then(function (one) {
            reads.push(one);
            return sleep(45).then(function () {
              return next(index + 1);
            });
          });
        }
        return next(0).then(function (frames) {
          result.frames = frames;
        });
      })
      .then(function () {
        // (c) The foreground round trip.
        return reading('before-hide').then(function (before) {
          result.roundTrip.before = before;
          result.roundTrip.readyForHarnessAt = new Date().toISOString();
          /*
           * Tell the harness on the host, through the same channel as everything else, that the
           * "before" reading is held and the gap should start now. Without this the two ends would
           * be racing: tools/spectrum-roundtrip.mjs backgrounds the app, and it has to do it *after*
           * this reading and not before it.
           */
          try {
            fetch('/__report', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ progress: 'ready for the foreground round trip', at: new Date().toISOString() }),
            });
          } catch (error) {
            void error;
          }
          return waitForRoundTrip();
        });
      })
      .then(function (events) {
        if (!events.real) return syntheticRoundTrip().then(function (synthetic) {
          result.roundTrip.driver = 'the probe itself (no harness behind this run)';
          result.roundTrip.events = synthetic.events;
          return true;
        });
        result.roundTrip.driver = 'the harness, with the app really backgrounded and relaunched';
        result.roundTrip.events = events.events;
        return true;
      })
      .then(function () {
        return sleep(1200);
      })
      .then(function () {
        return reading('after-show').then(function (after) {
          result.roundTrip.after = after;
          result.roundTrip.gapMs = after.at - result.roundTrip.before.at;
          result.roundTrip.positionAdvancedMs = after.positionMs - result.roundTrip.before.positionMs;
          document.removeEventListener('visibilitychange', onVisibility);
          return result;
        });
      })
      .then(function () {
        /*
         * (d) No audio, no bars.
         *
         * A pause is the one silence this library can produce on the device: every fixture in the
         * stress library is a continuous tone (tools/audio.mjs), so there is no quiet passage to seek
         * into and no silent track to play. What this does prove is the other half of the owner's
         * complaint — that the bars are a reading and not a decoration, and that the app stops
         * claiming it is drawing one when nothing is playing: the engine must drop the live frame,
         * say why, and the canvas must stop showing bars it is not measuring.
         */
        var play = document.querySelector('.now-bar .transport.big');
        if (!play) return null;
        play.click();
        return sleep(700).then(function () {
          return reading('paused');
        });
      })
      .then(function (paused) {
        if (paused) result.paused = paused;
        return result;
      });
  }

  /**
   * The queue, the boundary and the two buttons, from inside the shipping app (v1.9.9).
   *
   * The paths this reads exist only in the wrapped build with the native player: a tap that goes to
   * AVFoundation, a track that ends **while the app is not running**, and the two transport buttons.
   * It is run from the *app* in the simulator (`tools/device-probe.mjs --app …`), and the harness
   * behind it (`tools/spectrum-roundtrip.mjs`) is what really backgrounds and relaunches the app in
   * the middle — the beat it waits for is posted from here.
   *
   * What it records, in the order a person would do it:
   *
   *   (a) tap a row, and how long the first note took;
   *   (b) the next button, and how long that took;
   *   (c) previous inside the first three seconds — a different track;
   *   (d) previous past three seconds — the same track, seeked back to its start (the rule that was
   *       dead code in v1.9.8);
   *   (e) a track end **with the app sent to the background by the harness**: the reading before the
   *       gap and the reading after it, which is where a boundary taken by the phone's player shows
   *       up as a different track.
   */
  function queueProbe(options) {
    var opts = options || {};
    var roundTripTimeoutMs = opts.roundTripTimeoutMs || 60000;
    var result = { startedAt: new Date().toISOString(), tap: {}, next: {}, previous: {}, roundTrip: {} };
    queueProbe.lastResult = result;

    function sleep(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    }

    function api() {
      return window.__navilite || null;
    }

    function status() {
      var seam = api();
      return seam ? seam.status() : null;
    }

    function track() {
      var seam = api();
      return seam && seam.playingRow ? seam.playingRow() : null;
    }

    function contextLine() {
      var seam = api();
      return seam && seam.context ? seam.context() : null;
    }

    /** Everything the report needs to say what was playing, in one place. */
    function reading(label) {
      var state = status();
      return {
        label: label,
        at: Date.now(),
        track: track(),
        context: contextLine(),
        state: state ? state.state : null,
        backend: state ? state.backend : null,
        positionMs: state ? Math.round(state.positionMs) : null,
        durationMs: state ? Math.round(state.durationMs) : null,
        reason: state ? state.modeReason : null,
        nativeBoundary: state ? state.nativeBoundary : null,
        warmedIds: state ? state.warmedIds : null,
      };
    }

    function button(label) {
      var node = document.querySelector('.playerbar button[aria-label="' + label + '"]') || document.querySelector('button[aria-label="' + label + '"]');
      if (!node) return false;
      node.click();
      return true;
    }

    /** Set the seek bar's value and commit it, the way a finger lifting off it does. */
    function seekTo(ratio) {
      var input = document.querySelector('.playerbar input.progress') || document.querySelector('input.progress');
      if (!input) return false;
      input.value = String(Math.round(Math.max(0, Math.min(1, ratio)) * 1000));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    /** Wait until the engine says it is playing, or the deadline runs out. */
    function waitPlaying(deadlineMs) {
      var started = Date.now();
      return new Promise(function (resolve) {
        var timer = setInterval(function () {
          var state = status();
          if (state && state.state === 'playing') {
            clearInterval(timer);
            resolve(Date.now() - started);
            return;
          }
          if (Date.now() - started > deadlineMs) {
            clearInterval(timer);
            resolve(-1);
          }
        }, 50);
      });
    }

    /** Wait until a different track is the one playing, or the deadline runs out. */
    function waitTrackChange(before, deadlineMs) {
      var started = Date.now();
      return new Promise(function (resolve) {
        var timer = setInterval(function () {
          var now = track();
          if (now && now !== before) {
            clearInterval(timer);
            resolve(Date.now() - started);
            return;
          }
          if (Date.now() - started > deadlineMs) {
            clearInterval(timer);
            resolve(-1);
          }
        }, 50);
      });
    }

    var realEvents = [];
    function onVisibility() {
      realEvents.push({ hidden: document.hidden, at: Date.now() });
    }

    /** The harness backgrounds and relaunches the app; this resolves when it is back. */
    function waitForRoundTrip() {
      var started = Date.now();
      return new Promise(function (resolve) {
        var timer = setInterval(function () {
          var hidden = realEvents.some(function (event) {
            return event.hidden;
          });
          var shownAgain = hidden && realEvents[realEvents.length - 1].hidden === false;
          if (shownAgain) {
            clearInterval(timer);
            resolve({ real: true, events: realEvents.slice(), waitedMs: Date.now() - started });
            return;
          }
          if (Date.now() - started > roundTripTimeoutMs) {
            clearInterval(timer);
            resolve({ real: false, events: realEvents.slice(), waitedMs: Date.now() - started });
          }
        }, 250);
      });
    }

    document.addEventListener('visibilitychange', onVisibility);

    return waitFor("Boolean(window.__navilite && window.__navilite.libraryReady())", 'the library to be connected', 30000)
      .then(function () {
        location.hash = '#/album/album-ja-1';
        return waitFor("document.querySelectorAll('.row.song').length > 0", 'the stress album', 20000);
      })
      .then(function () {
        /* (a) A tap, the way a person does it. */
        result.tap.tappedAt = Date.now();
        result.tap.target = playRow(0);
        return sleep(120).then(function () {
          result.tap.state120ms = status() ? status().state : null;
          return waitPlaying(30000);
        });
      })
      .then(function (msToPlaying) {
        result.tap.msToPlaying = msToPlaying;
        result.tap.after = reading('after the tap');
        /* (b) The next button. */
        result.next.before = reading('before next');
        result.next.clicked = button('Next');
        return waitTrackChange(result.next.before.track, 30000);
      })
      .then(function (msToChange) {
        result.next.msToChange = msToChange;
        result.next.after = reading('after next');
        /* (c) Previous inside the first three seconds: a different track again. */
        result.previous.earlyBefore = reading('before previous (inside three seconds)');
        result.previous.earlyClicked = button('Previous');
        return waitTrackChange(result.previous.earlyBefore.track, 30000).then(function (ms) {
          result.previous.earlyMsToChange = ms;
        });
      })
      .then(function () {
        result.previous.earlyAfter = reading('after previous (inside three seconds)');
        /*
         * (d) Now wait until this track is past three seconds and press previous again: the rule is
         * "restart this one", so the track must NOT change and the position must fall.
         */
        return new Promise(function (resolve) {
          var started = Date.now();
          var timer = setInterval(function () {
            var state = status();
            if ((state && state.positionMs > 3500) || Date.now() - started > 20000) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      })
      .then(function () {
        result.previous.lateBefore = reading('before previous (past three seconds)');
        result.previous.lateClicked = button('Previous');
        return sleep(800).then(function () {
          result.previous.lateAfter = reading('after previous (past three seconds)');
        });
      })
      .then(function () {
        /*
         * (e) The boundary, with the app really away. The track is seeked to four seconds from its
         * end, the harness is told the reading is held, and it backgrounds the app long enough for
         * the track to end while nothing is looking. What comes back is the reading after the
         * return: a different track there is a boundary the phone's player took by itself.
         */
        result.roundTrip.before = reading('before the app was backgrounded');
        var duration = status() ? status().durationMs : 0;
        seekTo(duration > 8000 ? 1 - 4000 / duration : 0.8);
        return sleep(600).then(function () {
          result.roundTrip.positionAfterSeek = reading('after the seek');
          try {
            fetch('/__report', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ progress: 'ready for the foreground round trip', at: new Date().toISOString() }),
            });
          } catch (error) {
            void error;
          }
          return waitForRoundTrip();
        });
      })
      .then(function (events) {
        result.roundTrip.driver = events.real
          ? 'the harness, with the app really backgrounded and relaunched'
          : 'nothing backgrounded the app: no real visibility round trip arrived';
        result.roundTrip.events = events.events;
        return sleep(2500);
      })
      .then(function () {
        result.roundTrip.after = reading('after the app came back');
        result.roundTrip.trackChanged =
          Boolean(result.roundTrip.before.track) && result.roundTrip.after.track !== result.roundTrip.before.track;
        document.removeEventListener('visibilitychange', onVisibility);
        return result;
      });
  }

  /**
   * The same seam, read **without touching anything**: what a cold launch looks like (v1.9.9).
   *
   * The launch must be inert — the queue restored, nothing fetched, nothing played, no crash — so
   * this scenario only reads. It is run after the harness has *terminated* the app and launched it
   * again, which is exactly the sequence that used to crash-loop.
   */
  function restoredProbe() {
    var result = { startedAt: new Date().toISOString() };
    return waitFor("Boolean(window.__navilite && window.__navilite.libraryReady())", 'the library to be connected', 30000)
      .then(function () {
        return new Promise(function (resolve) {
          setTimeout(resolve, 3000);
        });
      })
      .then(function () {
        var state = window.__navilite.status();
        result.state = state.state;
        result.backend = state.backend;
        result.positionMs = Math.round(state.positionMs);
        result.durationMs = Math.round(state.durationMs);
        result.playingRow = window.__navilite.playingRow();
        result.context = window.__navilite.context();
        result.reason = state.modeReason;
        result.nativeBoundary = state.nativeBoundary;
        return result;
      });
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
    queue('Settings (#/settings)', function () {
      return setHash('#/settings', "document.querySelector('.settings') !== null", 'settings');
    });
    /*
     * The two entries that used to sit here both keyed off the playback preference dropdown — the
     * one whose own text was wider than its box (v1.5.1) and the one that took focus at 15 px and
     * zoomed the screen in (v1.5). v1.7.3 deleted that dropdown along with the second audio engine
     * it selected, so neither state can recur and there is nothing left on this route to walk.
     */
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
   * A finger inside the page, at a cadence this file sets — because the pager's release velocity *is*
   * the `performance.now()` gap between its last two `touchmove`s, so a gesture driven from outside the
   * page is clocked by the driver and not by the check.
   *
   * Through the input pipeline each move costs a round trip: measured on this box, a
   * `stepDelayMs: 6` CDP drag hands the pager gaps of 212–330 ms per move, and on a quiet one under
   * 80 ms. At 393 px wide, 26 px of travel per step and a 140 ms projection (`src/ui/pager.ts`:
   * `PROJECTION_MS`, `COMMIT`), a 0.2-pane drag commits unless that gap is longer than ~78 ms — so a
   * check that means "released slowly" is deciding on a number it does not control. This drives the
   * same listeners with `TouchEvent`s at `gapMs` between moves and records what the page clock saw.
   *
   * Returns `{ ms, offsets, events }`: the offsets under the finger after each move, and one entry per
   * event (`type`, `x`, the timestamp the listener itself saw — same task, same clock — and the gap
   * back to the previous event), which is what a check about velocity has to report.
   *
   * `sameTaskRelease: true` lands the **final move in the same task as the one before it** instead of
   * after another timer. A timer can only be late, never early: asked for `gapMs: 8`, the pager's own
   * clock has seen 9–47 ms, and a gap longer than ~78 ms at this distance snaps the pane back — so a
   * check whose claim is "released *fast*" would go red on a correct app whenever the timer slipped.
   * In one task the gap is the synchronous work between two `dispatchEvent`s (well under a
   * millisecond), which is a *faster* finger, so the claim still holds and now holds by construction.
   * Gestures whose claim is "released *slowly*" must not set it — there the timer's lateness is the
   * thing being asked for.
   */
  function pagerGesture(options) {
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
    var events = [];
    var fire = function (type, x) {
      var point = make(x);
      var at = performance.now();
      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === 'touchend' ? [] : [point],
          targetTouches: type === 'touchend' ? [] : [point],
          changedTouches: [point],
        }),
      );
      var previous = events[events.length - 1];
      events.push({ type: type, x: Math.round(x), t: at, gapMs: previous ? at - previous.t : null });
    };
    var offsets = [];
    return new Promise(function (resolve) {
      var started = performance.now();
      fire('touchstart', fromX);
      var send = function (index) {
        if (index > steps) {
          fire('touchend', toX);
          resolve({
            ms: Math.round(performance.now() - started),
            offsets: offsets,
            sameTaskRelease: options.sameTaskRelease === true,
            events: events.map(function (event) {
              return {
                type: event.type,
                x: event.x,
                t: Math.round(event.t * 10) / 10,
                gapMs: event.gapMs === null ? null : Math.round(event.gapMs * 10) / 10,
              };
            }),
          });
          return;
        }
        var x = fromX + ((toX - fromX) * index) / steps;
        var emit = function () {
          fire('touchmove', x);
          var state = pagerState();
          if (state) offsets.push(state.offset);
          send(index + 1);
        };
        // The *release* move goes out in this same task, so the pager's clock measures the synchronous
        // work between its last two moves rather than how late a timer ran (see above). Both events
        // still reach the listener and the offsets still advance: the same finger, a faster last step.
        // Every other move keeps the original spacing, so a gesture that asks for slow still gets slow.
        if (index > 1 && index === steps && options.sameTaskRelease === true) emit();
        else setTimeout(emit, gapMs);
      };
      send(1);
    });
  }

  /**
   * A flick: `pagerGesture` at a finger's cadence (26 px every 8 ms), with the release move dispatched
   * in the same task as the one before it — a flick's claim is that it is released *fast*, and a timer
   * can only be late, so the deterministic release is the only one that keeps the claim about the app
   * rather than about the box. A commit from here at the same shallow distance the slow release snaps
   * back from cannot be anything but the velocity projection.
   */
  function flickPager(options) {
    var merged = {};
    for (var key in options) if (Object.prototype.hasOwnProperty.call(options, key)) merged[key] = options[key];
    // A caller may opt out by passing `sameTaskRelease: false` — that is the negative control, a flick
    // paced by a timer, which releases slowly and must snap back.
    if (typeof merged.sameTaskRelease !== 'boolean') merged.sameTaskRelease = true;
    return pagerGesture(merged);
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

  /* ------------------------------------------- the gestures, in the shipping engine (v1.5 follow-up) */

  /**
   * The owner's two v1.5 reports are about a *finger*, and every number in `docs/verification.md`
   * §13.3 comes from Chrome's `Input.dispatchTouchEvent` at 393x852. A simulator has no CDP, so
   * between "Chrome says the axis lock holds" and "Safari on the phone does" there was an engine
   * and an input path nobody had run. This is that path: the same gestures, dispatched as real
   * `TouchEvent`s inside Safari in the simulator, with the geometry read between the moves.
   *
   * What it can and cannot see, stated rather than implied. The events go straight to the page's
   * listeners, so what is measured is the *app's* behaviour in the shipping engine: the axis lock,
   * the finger-following transform, the tiling, the snap and the route. What an untrusted event
   * cannot do is have a default action, so the browser's own half — the scroll a vertical drag
   * would produce, and Safari's edge-swipe on a gesture that starts at the screen edge — is not
   * reproduced here and is still Chrome's (and the owner's thumb's) to confirm. The one thing this
   * can say about the axis lock's other half is `defaultPrevented`: the claim is that a vertical
   * gesture is handed back *untouched*, and an untouched gesture is exactly what `false` here means.
   */

  /**
   * Which input constructors this engine actually has — the precondition of the in-page path.
   *
   * `new Touch(...)` and `new TouchEvent(...)` are the two the sweep needs, and they are not
   * universal: WebKit exposes them from Safari 14 on, and a page that finds them missing has no
   * in-page gesture path at all. Reported once per run so a failure says *why*.
   */
  function inputSupport() {
    return {
      Touch: typeof Touch,
      TouchEvent: typeof TouchEvent,
      PointerEvent: typeof PointerEvent,
      touchPoints: typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : null,
      canConstructTouch: (function () {
        try {
          return typeof Touch === 'function' && typeof TouchEvent === 'function' && !!new TouchEvent('touchstart', { bubbles: true });
        } catch (error) {
          return 'throws: ' + error.message;
        }
      })(),
    };
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * The x of a `matrix(1, 0, 0, 1, x, 0)` transform, or 0 for `none`.
   *
   * Takes an element *or* the box `nowGeometry()` returns for one — the boxes carry the computed
   * transform already, and reading it from the box is what keeps `getComputedStyle` out of a loop
   * that runs once per move of every gesture.
   */
  function translateXOf(target) {
    var value = '';
    if (target && target.nodeType === 1) value = getComputedStyle(target).transform;
    else if (target && typeof target.translate === 'string') value = target.translate;
    var match = /matrix\(1, 0, 0, 1, (-?[\d.]+), 0\)/.exec(String(value));
    return match ? Number(match[1]) : 0;
  }

  /**
   * One finger, inside the page: down, `steps` even moves, up — sampling as it goes.
   *
   * `target` is what is under the finger, resolved with `elementFromPoint` so the event travels the
   * path it really would (and lands on a `<select>` or a range input if the coordinates are wrong,
   * which the report then shows instead of hiding).
   */
  function fingerDrag(options) {
    var from = options.from;
    var to = options.to;
    var steps = options.steps || 5;
    var gapMs = typeof options.gapMs === 'number' ? options.gapMs : 20;
    var sampleEvery = typeof options.sampleEvery === 'number' ? options.sampleEvery : 1;
    var target = document.elementFromPoint(Math.round(from.x), Math.round(from.y)) || document.querySelector('#app');
    if (!target || typeof Touch !== 'function' || typeof TouchEvent !== 'function') {
      /*
       * Reported, not swallowed. A build whose engine cannot construct a `Touch` has no in-page
       * gesture path at all, and a null here used to surface as "undefined is not an object" three
       * frames later — which says nothing about which constructor was missing.
       */
      return Promise.resolve({
        unavailable: inputSupport(),
        target: target ? selectorFor(target) : null,
      });
    }
    var identifier = 11;
    var point = function (x, y) {
      return new Touch({ identifier: identifier, target: target, clientX: Math.round(x), clientY: Math.round(y) });
    };
    var fire = function (type, x, y, touches) {
      var event = new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: touches,
        targetTouches: touches,
        changedTouches: [point(x, y)],
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    var samples = [];
    var prevented = [];
    return new Promise(function (resolve) {
      var started = performance.now();
      fire('touchstart', from.x, from.y, [point(from.x, from.y)]);
      var send = function (index) {
        if (index > steps) {
          fire('touchend', to.x, to.y, []);
          resolve({
            target: selectorFor(target),
            from: { x: Math.round(from.x), y: Math.round(from.y) },
            to: { x: Math.round(to.x), y: Math.round(to.y) },
            ms: Math.round(performance.now() - started),
            /** Whether anything called `preventDefault` on a move: the axis lock's own claim. */
            prevented: prevented,
            samples: samples,
          });
          return;
        }
        var x = from.x + ((to.x - from.x) * index) / steps;
        var y = from.y + ((to.y - from.y) * index) / steps;
        setTimeout(function () {
          prevented.push(fire('touchmove', x, y, [point(x, y)]));
          if (sampleEvery === 0 ? index === steps : index % sampleEvery === 0) {
            samples.push({
              x: Math.round(x),
              y: Math.round(y),
              pager: pagerState(),
              geometry: nowGeometry(),
            });
          }
          send(index + 1);
        }, gapMs);
      };
      send(1);
    });
  }

  /** The centre of a box, kept clear of the very top and the very bottom of the screen. */
  function centreOf(selector, fromTop) {
    var el = document.querySelector(selector);
    var rect = el ? el.getBoundingClientRect() : null;
    var height = window.innerHeight;
    var middle = rect ? rect.top + rect.height / 2 : height / 2;
    var y = typeof fromTop === 'number' ? rect.top + rect.height * fromTop : middle;
    return Math.max(60, Math.min(height - 60, Math.round(y)));
  }

  /**
   * The whole sweep, self-driven, so the device harness has nothing to do but wait for the report.
   *
   * The order is the ring's, and each step waits for the pager to settle before the next gesture, so
   * every sample belongs to the gesture it is under.
   */
  function deviceGestureSweep() {
    if (!pagerState()) {
      // A build with no pager (the v1.4 payload the same harness is run against) has no gestures to
      // measure; saying so beats reporting zeroes as if they were readings.
      return Promise.resolve({ unsupported: 'this build has no pager' });
    }
    var width = window.innerWidth;
    var height = window.innerHeight;
    var out = {
      device: { width: width, height: height, devicePixelRatio: window.devicePixelRatio },
      input: 'TouchEvent dispatched in the page (see the note above fingerDrag)',
      inputSupport: inputSupport(),
      steps: {},
    };
    /*
     * "Settled" has to mean *at rest on a pane*, not "some frames have passed".
     *
     * The pager's own `settled` goes true the moment a gesture ends, and its snap animation then
     * runs for up to 340 ms — so a reading taken three frames later measures the animation, not the
     * screen. The first device run did exactly that: it caught the opening drag mid-flight at
     * offset 1.09 and every reading after it inherited the moving pager. The offset being an
     * integer is what a pane at rest looks like from outside.
     */
    var settle = function () {
      return waitFor(
        "(function(){var p=window.__navilite.pager();return Boolean(p)&&p.settled===true&&Math.abs(p.offset-Math.round(p.offset))<0.01;})()",
        'the pager to come to rest on a pane',
        5000,
      ).then(function () {
        return nextFrames(2);
      });
    };

    /* 1. The axis lock on the playlist: 200 px across, 240 px up. Mostly vertical. */
    return prepareScroll()
      .then(function (before) {
        var pagerBefore = pagerState();
        out.steps.diagonalOnList = { scrollTopBefore: round2(before.scrollTop), pagerBefore: pagerBefore };
        return fingerDrag({ from: { x: 300, y: 600 }, to: { x: 100, y: 360 }, steps: 4, gapMs: 20 });
      })
      .then(function (drag) {
        return settle().then(function () {
          var state = scrollState();
          out.steps.diagonalOnList.drag = drag;
          out.steps.diagonalOnList.scrollTopAfter = round2(state.scrollTop);
          out.steps.diagonalOnList.pagerAfter = pagerState();
          out.steps.diagonalOnList.listTranslate = translateXOf(scrollSurfaces().scroller);
        });
      })
      /* 2. Onto the now screen, on the spectrum pane, through the app's own tap. */
      .then(function () {
        return openNowFromList();
      })
      .then(function () {
        /* 3. Spectrum -> lyrics: does the pane follow the finger, and do the two tile? */
        var travelled = 0.45 * width;
        var y = centreOf('.now-page-spectrum');
        return fingerDrag({ from: { x: Math.round(width * 0.84), y: y }, to: { x: Math.round(width * 0.84 - travelled), y: y }, steps: 5, gapMs: 24 }).then(function (drag) {
          out.steps.follow = { y: y, travelled: Math.round(travelled), drag: drag };
          var samples = drag.samples || [];
          var expected = samples.map(function (sample) {
            return 1 + (Math.round(width * 0.84) - sample.x) / width;
          });
          out.steps.follow.expected = expected;
          out.steps.follow.offsetErrorPx = samples.reduce(function (worst, sample, index) {
            return Math.max(worst, Math.abs((sample.pager ? sample.pager.offset : 0) - expected[index]) * width);
          }, 0);
          out.steps.follow.stripErrorPx = samples.reduce(function (worst, sample, index) {
            var stripX = translateXOf(sample.geometry.pages);
            return Math.max(worst, Math.abs(stripX + (expected[index] - 1) * width));
          }, 0);
          out.steps.follow.tilingWorstPx = samples.reduce(function (worst, sample) {
            var g = sample.geometry;
            return Math.max(
              worst,
              Math.abs(g.spectrum.right - g.lyricsPane.left),
              Math.abs(g.now.left),
              Math.abs(g.now.right - width),
            );
          }, 0);
          out.steps.follow.monotonic = samples.every(function (sample, index) {
            return index === 0 || (sample.pager ? sample.pager.offset : 0) > (samples[index - 1].pager ? samples[index - 1].pager.offset : 0);
          });
          return settle().then(function () {
            var rest = nowGeometry();
            out.steps.follow.rest = { position: rest.pager ? rest.pager.position : null, route: rest.route, strip: translateXOf(rest.pages) };
          });
        });
      })
      /* 4. A short drag moves the pane under the finger and snaps back to the one it started on.
       *
       *    Deliberately slow, and slower than the Chrome harness has to be. That harness drives the
       *    input pipeline, which costs a round trip per move, so its "fast" gesture is already slow;
       *    this one drives the listeners at a real finger's cadence, where the same 0.12 panes at
       *    30 ms would be a flick — and a flick that commits is correct behaviour, not a failure. So
       *    the gesture is slowed until distance is all there is, and the check is about distance. */
      .then(function () {
        var y = centreOf('.now-page-lyrics');
        return fingerDrag({ from: { x: Math.round(width * 0.84), y: y }, to: { x: Math.round(width * 0.84 - 0.12 * width), y: y }, steps: 6, gapMs: 60 }).then(function (drag) {
          return settle().then(function () {
            var rest = nowGeometry();
            out.steps.shortDrag = {
              offsets: drag.samples.map(function (sample) {
                return sample.pager ? sample.pager.offset : null;
              }),
              ms: drag.ms,
              rest: { position: rest.pager ? rest.pager.position : null, route: rest.route },
            };
          });
        });
      })
      /* 5. The same shape, over the lyrics: a scroll must not turn the page here either. */
      .then(function () {
        var y = centreOf('.now-page-lyrics');
        var before = pagerState();
        return fingerDrag({ from: { x: 300, y: Math.min(height - 60, y + 120) }, to: { x: 100, y: Math.max(60, y - 120) }, steps: 4, gapMs: 20 }).then(function (drag) {
          return settle().then(function () {
            out.steps.diagonalOnLyrics = {
              drag: drag,
              paneFound: Boolean(document.querySelector('.now-page-lyrics')),
              pagerBefore: before,
              pagerAfter: pagerState(),
            };
          });
        });
      })
      /* 6. A flick commits on velocity, not on distance. */
      .then(function () {
        return flickPager({ selector: '.now-page-lyrics', fromX: Math.round(width * 0.84), toX: Math.round(width * 0.84 - 0.2 * width), steps: 3, gapMs: 8 }).then(function (flick) {
          return delay(600).then(function () {
            var rest = nowGeometry();
            out.steps.flick = { flick: flick, rest: { position: rest.pager ? rest.pager.position : null, route: rest.route } };
          });
        });
      })
      /* 7. The ring: left from the playlist is the spectrum, left again the lyrics, and right from
       *    the lyrics the playlist again — every transition the owner named. */
      .then(function () {
        var ring = [];
        var step = function (from, to) {
          return fingerDrag({ from: { x: from, y: 300 }, to: { x: to, y: 300 }, steps: 5, gapMs: 20 })
            .then(settle)
            .then(function (drag) {
              var geometry = nowGeometry();
              ring.push({
                from: from,
                to: to,
                position: geometry.pager ? geometry.pager.position : null,
                route: geometry.route,
                tilingWorstPx: (drag.samples || []).reduce(function (worst, sample) {
                  return Math.max(worst, Math.abs(sample.geometry.list.right - sample.geometry.now.left));
                }, 0),
                listTranslate: (drag.samples || []).map(function (sample) {
                  return translateXOf(sample.geometry.list);
                }),
                offsets: (drag.samples || []).map(function (sample) {
                  return sample.pager ? sample.pager.offset : null;
                }),
                unavailable: drag.unavailable || null,
              });
              return null;
            });
        };
        return step(340, 40)
          .then(function () {
            return step(340, 40);
          })
          .then(function () {
            return step(340, 40);
          })
          .then(function () {
            return step(40, 340);
          })
          .then(function () {
            out.steps.ring = ring;
          });
      })
      .then(function () {
        return { out: out, final: nowGeometry() };
      })
      .then(function (result) {
        result.out.finalRoute = result.final.route;
        return result.out;
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
    nativeSpectrumProbe: nativeSpectrumProbe,
    // v1.9.9: the queue, the two buttons and the boundary taken with the app really away.
    queueProbe: queueProbe,
    restoredProbe: restoredProbe,
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
    pagerGesture: pagerGesture,
    // v1.5 follow-up: the settings overflow, taken apart in the shipping engine, and the gestures.
    surfaceSideScroll: surfaceSideScroll,
    settingsOverflowProbe: settingsOverflowProbe,
    fingerDrag: fingerDrag,
    inputSupport: inputSupport,
    deviceGestureSweep: deviceGestureSweep,
  };
})();
