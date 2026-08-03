/**
 * Admin page tree: expand/collapse categories and reorder siblings without
 * losing scroll position. The row moves first, then the server is told; a
 * rejection reloads so the table always matches the database.
 */
(function () {
  "use strict";

  var tree = document.getElementById("adminPageTree");
  if (!tree) return;

  var busy = false;
  var reorderUrl = tree.getAttribute("data-reorder-url") || "/admin/reorder";
  var csrfToken = document.body.getAttribute("data-csrf") || "";

  function rowBySlug(slug) {
    return tree.querySelector('tr.admin-tree-row[data-slug="' + CSS.escape(slug) + '"]');
  }

  /** Direct children of a parent ("" = top level). */
  function siblingRows(parentSlug) {
    if (!parentSlug) {
      return Array.prototype.slice.call(tree.querySelectorAll('tr.admin-tree-row[data-depth="0"]'));
    }
    return Array.prototype.slice.call(
      tree.querySelectorAll('tr.admin-tree-row[data-parent="' + CSS.escape(parentSlug) + '"]')
    );
  }

  /** A row plus all of its descendants, in table order. */
  function collectSubtree(slug) {
    var row = rowBySlug(slug);
    if (!row) return [];
    var out = [row];
    siblingRows(slug).forEach(function (child) {
      var childSlug = child.getAttribute("data-slug");
      if (childSlug) out = out.concat(collectSubtree(childSlug));
    });
    return out;
  }

  function setExpanded(parentSlug, expanded) {
    var btn = tree.querySelector('.tree-toggle[data-toggle-children="' + CSS.escape(parentSlug) + '"]');
    if (btn) {
      btn.setAttribute("aria-expanded", expanded ? "true" : "false");
      btn.textContent = expanded ? "▾" : "▸";
    }
    siblingRows(parentSlug).forEach(function (row) {
      if (expanded) {
        row.hidden = false;
        row.classList.remove("is-collapsed-row");
      } else {
        row.hidden = true;
        row.classList.add("is-collapsed-row");
        var childSlug = row.getAttribute("data-slug");
        if (childSlug) setExpanded(childSlug, false);
      }
    });
  }

  function refreshSiblingButtons(parentSlug) {
    var sibs = siblingRows(parentSlug);
    sibs.forEach(function (row, i) {
      var up = row.querySelector('.reorder-btn[data-direction="up"]');
      var down = row.querySelector('.reorder-btn[data-direction="down"]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === sibs.length - 1;
    });
  }

  function insertBlockBefore(block, reference) {
    if (!reference || !block.length) return;
    var frag = document.createDocumentFragment();
    block.forEach(function (row) { frag.appendChild(row); });
    reference.parentNode.insertBefore(frag, reference);
  }

  function insertBlockAfter(block, afterNode) {
    if (!afterNode || !block.length) return;
    var parent = afterNode.parentNode;
    var ref = afterNode.nextSibling;
    var inBlock = Object.create(null);
    block.forEach(function (row) { inBlock[row.getAttribute("data-slug") || ""] = true; });
    while (ref && ref.nodeType === 1 && inBlock[ref.getAttribute("data-slug") || ""]) {
      ref = ref.nextSibling;
    }
    var frag = document.createDocumentFragment();
    block.forEach(function (row) { frag.appendChild(row); });
    parent.insertBefore(frag, ref);
  }

  function moveInDom(slug, direction) {
    var row = rowBySlug(slug);
    if (!row) return false;
    var parentSlug = row.getAttribute("data-parent") || "";
    var sibs = siblingRows(parentSlug);
    var idx = sibs.indexOf(row);
    if (idx < 0) return false;

    var block = collectSubtree(slug);
    if (!block.length) return false;

    if (direction === "up") {
      if (idx <= 0) return false;
      insertBlockBefore(block, sibs[idx - 1]);
    } else if (direction === "down") {
      if (idx >= sibs.length - 1) return false;
      var nextBlock = collectSubtree(sibs[idx + 1].getAttribute("data-slug"));
      if (!nextBlock.length) return false;
      insertBlockAfter(block, nextBlock[nextBlock.length - 1]);
    } else {
      return false;
    }

    refreshSiblingButtons(parentSlug);
    return true;
  }

  function saveReorder(slug, direction) {
    return fetch(reorderUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": csrfToken,
      },
      body: new URLSearchParams({ slug: slug, direction: direction, csrf_token: csrfToken }),
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  tree.addEventListener("click", function (event) {
    var toggle = event.target.closest(".tree-toggle");
    if (toggle && tree.contains(toggle)) {
      event.preventDefault();
      var toggleSlug = toggle.getAttribute("data-toggle-children");
      if (!toggleSlug) return;
      setExpanded(toggleSlug, toggle.getAttribute("aria-expanded") !== "true");
      return;
    }

    var btn = event.target.closest(".reorder-btn");
    if (!btn || !tree.contains(btn) || btn.disabled || busy) return;
    event.preventDefault();

    var row = btn.closest("tr.admin-tree-row");
    var slug = row && row.getAttribute("data-slug");
    var direction = btn.getAttribute("data-direction");
    if (!slug || (direction !== "up" && direction !== "down")) return;
    if (!moveInDom(slug, direction)) return;

    busy = true;
    tree.classList.add("is-reordering");
    saveReorder(slug, direction)
      .then(function (data) {
        if (!data || !data.ok) window.location.reload();
      })
      .catch(function () {
        window.location.reload();
      })
      .finally(function () {
        busy = false;
        tree.classList.remove("is-reordering");
      });
  });
})();
