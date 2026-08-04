/**
 * Public chrome: mobile nav, sticky category expand/collapse, page TOC,
 * nav, image lightbox and confirm-before-submit. Loaded on every page.
 */
(function () {
  "use strict";

  /* ---------------------------------------------------- mobile navigation */
  (function () {
    var toggle = document.getElementById("menuToggle");
    var nav = document.getElementById("siteSidenav");
    var backdrop = document.getElementById("sidenavBackdrop");
    if (!toggle || !nav) return;

    function setOpen(open) {
      nav.classList.toggle("is-open", open);
      if (backdrop) {
        backdrop.classList.toggle("is-open", open);
        backdrop.hidden = !open;
      }
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    }

    toggle.addEventListener("click", function () {
      setOpen(!nav.classList.contains("is-open"));
    });
    if (backdrop) backdrop.addEventListener("click", function () { setOpen(false); });
    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        if (window.matchMedia("(max-width: 992px)").matches) setOpen(false);
      });
    });
  })();

  /* ------------------------------------------- remembered category state */
  (function () {
    var nav = document.querySelector(".sidenav-nav");
    if (!nav) return;

    var storageKey = "wikiflip.nav-category-state";
    var state = {};
    try {
      state = JSON.parse(window.localStorage.getItem(storageKey) || "{}") || {};
    } catch (error) {
      state = {};
    }

    function setExpanded(branch, link, expanded) {
      branch.classList.toggle("is-expanded", expanded);
      branch.classList.toggle("is-collapsed", !expanded);
      link.setAttribute("aria-expanded", expanded ? "true" : "false");
    }

    nav.querySelectorAll("li.has-children[data-nav-branch]").forEach(function (branch) {
      var slug = branch.getAttribute("data-nav-branch");
      var link = Array.prototype.find.call(branch.children, function (child) {
        return child.tagName === "A";
      });
      if (!slug || !link) return;

      if (state[slug] === "expanded" || state[slug] === "collapsed") {
        setExpanded(branch, link, state[slug] === "expanded");
      }

      // Click the chevron area (or any category link) to fold without navigating
      // away; the link itself still works on a second click.
      link.addEventListener("click", function () {
        var nextExpanded = !branch.classList.contains("is-expanded");
        setExpanded(branch, link, nextExpanded);
        state[slug] = nextExpanded ? "expanded" : "collapsed";
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(state));
        } catch (error) {
          /* navigation still works without storage */
        }
      });
    });
  })();

  /* ----------------------------------------------- image + PDF lightbox */
  (function () {
    var content = document.querySelector(".wiki-article-content");
    if (!content) return;

    var overlay = document.createElement("div");
    overlay.className = "image-lightbox";
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");

    var backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "image-lightbox-backdrop";
    backdrop.setAttribute("aria-label", "Close image preview");

    var panel = document.createElement("div");
    panel.className = "image-lightbox-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Image preview");

    var close = document.createElement("button");
    close.type = "button";
    close.className = "image-lightbox-close";
    close.setAttribute("aria-label", "Close image preview");
    close.textContent = "×";

    var image = document.createElement("img");
    image.className = "image-lightbox-image";

    var frame = document.createElement("iframe");
    frame.className = "image-lightbox-frame";
    frame.hidden = true;
    frame.setAttribute("title", "PDF preview");

    var caption = document.createElement("p");
    caption.className = "image-lightbox-caption";

    panel.append(close, image, frame, caption);
    overlay.append(backdrop, panel);
    document.body.appendChild(overlay);

    var activeTrigger = null;

    function closePreview() {
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
      document.body.classList.remove("image-lightbox-open");
      image.removeAttribute("src");
      frame.removeAttribute("src");
      if (activeTrigger) activeTrigger.focus();
      activeTrigger = null;
    }

    function openOverlay(trigger, label) {
      activeTrigger = trigger;
      var text = (label || "").trim();
      caption.textContent = text;
      caption.hidden = !text;
      overlay.hidden = false;
      overlay.setAttribute("aria-hidden", "false");
      document.body.classList.add("image-lightbox-open");
      close.focus();
    }

    function openPreview(trigger) {
      frame.hidden = true;
      frame.removeAttribute("src");
      image.hidden = false;
      image.src = trigger.currentSrc || trigger.src;
      image.alt = trigger.alt || "Expanded image";
      panel.setAttribute("aria-label", "Image preview");
      // Don't show the filename/path as a caption bar under photos.
      openOverlay(trigger, "");
    }

    /** Same overlay, full-size PDF viewer instead of an image. */
    function openPdf(trigger) {
      image.hidden = true;
      image.removeAttribute("src");
      frame.hidden = false;
      var label = trigger.getAttribute("data-pdf-title") || "PDF";
      frame.src = trigger.getAttribute("data-pdf-src") + "#view=FitH";
      frame.setAttribute("title", label);
      panel.setAttribute("aria-label", label);
      openOverlay(trigger, label);
    }

    content.querySelectorAll("img").forEach(function (img) {
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      if (!img.getAttribute("aria-label")) {
        img.setAttribute("aria-label", img.alt ? "Open image: " + img.alt : "Open image");
      }
    });

    content.addEventListener("click", function (event) {
      var pdf = event.target.closest(".pdf-thumb");
      if (pdf && content.contains(pdf)) {
        event.preventDefault();
        openPdf(pdf);
        return;
      }
      var img = event.target.closest("img");
      if (!img || !content.contains(img)) return;
      event.preventDefault();
      openPreview(img);
    });

    content.addEventListener("keydown", function (event) {
      if ((event.key !== "Enter" && event.key !== " ") || event.target.tagName !== "IMG") return;
      event.preventDefault();
      openPreview(event.target);
    });

    backdrop.addEventListener("click", closePreview);
    close.addEventListener("click", closePreview);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !overlay.hidden) closePreview();
    });
  })();

  /* --------------------------------------------- confirm before submitting */
  document.addEventListener("submit", function (event) {
    var message = event.target.getAttribute && event.target.getAttribute("data-confirm");
    if (message && !window.confirm(message)) event.preventDefault();
  });
})();
