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

  /** The nearest ancestor that clips or scrolls sideways — an innocent parent, if any. */
  function clippingAncestor(el) {
    var node = el.parentElement;
    while (node && node !== document.documentElement) {
      var overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden' || overflowX === 'clip') {
        return selectorFor(node);
      }
      node = node.parentElement;
    }
    return null;
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

  /** Is the document wider than the viewport, and if so, which element did it? */
  function measure() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var doc = document.documentElement;
    var overflowers = [];
    var selfOverflow = [];

    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
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
      documentClientWidth: doc.clientWidth,
      documentScrollWidth: doc.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      scrollingElementScrollWidth: doc.scrollingElement ? doc.scrollingElement.scrollWidth : null,
      horizontalOverflow: doc.scrollWidth - doc.clientWidth,
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
    return {
      lines: lines.length,
      visibleLines: visible,
      lineHeight: Math.round(lineHeight * 100) / 100,
      fontSize: lines[0] ? getComputedStyle(lines[0]).fontSize : null,
      panelHeight: Math.round(box.height * 100) / 100,
      coverVisible: coverBox ? coverBox.height > 0 : false,
      coverHeight: coverBox ? Math.round(coverBox.height * 100) / 100 : 0,
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
        run().then(function () {
          var state = Object.assign({ label: label, environment: environment() }, measure());
          if (typeof detail === 'function') {
            try {
              state.detail = detail();
            } catch (error) {
              state.detail = { error: String(error) };
            }
          }
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
    // The iOS focus-zoom check. iOS zooms the page in when a form field smaller than 16 px gets
    // focus, which makes the app wider than the screen and pannable sideways — the exact shape
    // of "slightly too wide … horizontal scroll". Measuring it is the only way to know whether
    // it happens on a given build and engine, so it is one of the audited states.
    queue('Library — search field focused (iOS focus-zoom check)', function () {
      return setHash('#/artists', "document.querySelectorAll('.row').length > 0", 'the artist list').then(function () {
        var input = document.querySelector('.page-head .field');
        if (input) input.focus();
        return new Promise(function (resolve) {
          setTimeout(resolve, 500);
        });
      });
    });
    queue('Artist (#/artist/artist-ja) — long Japanese album names in the grid', function () {
      return setHash('#/artist/artist-ja', "document.querySelectorAll('.card').length > 0", 'the stress artist');
    });
    queue('Album (#/album/album-ja-1) — long Japanese and unbroken-Latin track titles', function () {
      return setHash('#/album/album-ja-1', "document.querySelectorAll('.row.song').length > 0", 'the stress album');
    });
    queue('Playlists (#/playlists) — two very long playlist names', function () {
      return setHash('#/playlists', "document.querySelectorAll('.row').length > 2", 'the playlist list');
    });
    queue('Playlist (#/playlist/pl-stress-ja) — long Japanese playlist name', function () {
      return setHash('#/playlist/pl-stress-ja', "document.querySelectorAll('.row.song').length > 0", 'the stress playlist');
    });
    queue('Settings (#/settings) — the long playback-preference select', function () {
      return setHash('#/settings', "document.querySelector('select') !== null", 'settings');
    });
    queue('Changelog (#/changelog)', function () {
      return setHash('#/changelog', "document.querySelector('.release') !== null", 'the changelog');
    });
    queue('Now (#/now, spectrum) — long title, long "Playing from" line', function () {
      return setHash('#/playlist/pl-stress-ja', "document.querySelectorAll('.row.song').length > 0", 'the stress playlist again').then(function () {
        // A real tap on the row's play button: the app's own handler, not a debug hook.
        var rows = document.querySelectorAll('.row.song .row-play');
        if (rows.length > 0) rows[0].click();
        else throw new Error('no playable row in the stress playlist');
        return waitFor("location.hash === '#/now'", 'the now-playing screen').then(function () {
          return waitFor("Boolean(document.querySelector('.now-canvas'))", 'the spectrum canvas');
        }).then(function () {
          return new Promise(function (resolve) {
            setTimeout(resolve, 600); // let a frame or two of the visualiser land
          });
        });
      });
    });
    queue('Now (#/now, lyrics) — long unbroken Japanese lyric lines', function () {
      return setHash('#/now', 'true', 'nothing').then(function () {
        var pills = document.querySelectorAll('.pill-option');
        if (pills.length < 2) throw new Error('no lyrics pill');
        pills[1].click();
        return waitFor("document.querySelectorAll('.lyric-line').length > 0", 'the lyric lines').then(function () {
          return new Promise(function (resolve) {
            setTimeout(resolve, 250);
          });
        });
      });
    }, lyricsDensity);
    queue('Now (#/now, lyrics) — mid-swipe, finger down and moved', function () {
      beginSwipe('.now');
      return Promise.resolve();
    }, lyricsDensity);
    queue('Now (#/now, lyrics) — after the swipe completes', function () {
      endSwipe('.now');
      return new Promise(function (resolve) {
        setTimeout(resolve, 400);
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

  window.__naviliteLayoutAudit = {
    DEVICE: DEVICE,
    environment: environment,
    measure: measure,
    lyricsDensity: lyricsDensity,
    spectrumSnapshot: spectrumSnapshot,
    silenceAudio: silenceAudio,
    waitFor: waitFor,
    walk: walk,
  };
})();
