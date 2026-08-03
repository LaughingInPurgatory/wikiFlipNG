/**
 * Toast UI Editor (WYSIWYG + Markdown) for the page editor.
 *
 * Uploads go to /pages/upload and come back as a bare filename, which is what
 * gets written into the Markdown — the page body never contains absolute URLs.
 * PDFs are inserted as a plain Markdown link; the renderer turns a paragraph
 * holding only a PDF link into the inline viewer.
 */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("editForm");
    var host = document.getElementById("mdEditor");
    if (!form || !host) return;

    var titleInput = document.getElementById("pageTitle");
    var slugInput = document.getElementById("pageSlug");
    var parentSelect = document.getElementById("pageParent");
    var contentField = document.getElementById("contentMarkdown");
    var saveBtn = document.getElementById("saveBtn");
    var csrfToken = document.body.getAttribute("data-csrf") || "";
    var isNew = form.getAttribute("data-is-new") === "1";
    var initialMd = contentField ? contentField.value : "";
    var editor = null;
    var fallbackTa = null;
    var toastTimer = null;

    function showStatus(message, ok) {
      var toast = document.getElementById("saveToast");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "saveToast";
        toast.className = "save-toast";
        toast.setAttribute("role", "status");
        toast.setAttribute("aria-live", "polite");
        toast.hidden = true;
        document.body.appendChild(toast);
      }
      if (toastTimer) clearTimeout(toastTimer);
      toast.textContent = message;
      toast.classList.remove("is-success", "is-error", "is-visible");
      toast.classList.add(ok ? "is-success" : "is-error");
      toast.hidden = false;
      void toast.offsetWidth;
      toast.classList.add("is-visible");
      toastTimer = setTimeout(function () {
        toast.classList.remove("is-visible");
        setTimeout(function () { toast.hidden = true; }, 280);
      }, ok ? 3200 : 5000);
    }

    function slugify(text) {
      return String(text || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    }

    function currentSlug() {
      return slugInput ? slugInput.value.trim() : "";
    }

    function uploadFile(file) {
      var slug = currentSlug();
      if (!slug) return Promise.reject("Set a URL slug before uploading media.");

      var body = new FormData();
      body.append("file", file, file.name || "upload");
      body.append("slug", slug);
      body.append("csrf_token", csrfToken);
      if (titleInput) body.append("title", titleInput.value || slug);
      if (parentSelect) body.append("parent", parentSelect.value || "");

      return fetch("/pages/upload", {
        method: "POST",
        body: body,
        credentials: "same-origin",
        headers: { Accept: "application/json", "X-CSRF-Token": csrfToken },
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || !data.location) throw data.error || data.message || "Upload failed";
          return data;
        });
      });
    }

    function getMarkdown() {
      if (editor && typeof editor.getMarkdown === "function") return editor.getMarkdown();
      if (fallbackTa) return fallbackTa.value;
      return contentField ? contentField.value : "";
    }

    function appendMarkdown(snippet) {
      if (editor && typeof editor.setMarkdown === "function") {
        editor.setMarkdown(editor.getMarkdown() + "\n\n" + snippet + "\n");
      } else if (fallbackTa) {
        fallbackTa.value = fallbackTa.value + "\n\n" + snippet + "\n";
      }
    }

    /** Plain textarea when the bundled editor cannot start. */
    function initFallback(reason) {
      console.warn("Toast UI Editor unavailable:", reason);
      host.innerHTML = "";
      var note = document.createElement("p");
      note.className = "hint";
      note.textContent =
        "Visual editor could not load (" + reason + "). Using the Markdown text editor.";
      host.appendChild(note);

      fallbackTa = document.createElement("textarea");
      fallbackTa.className = "md-fallback-textarea";
      fallbackTa.rows = 18;
      fallbackTa.value = initialMd;
      fallbackTa.setAttribute("aria-label", "Markdown content");
      host.appendChild(fallbackTa);
    }

    function pdfButton() {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toastui-editor-toolbar-icons pdf-toolbar-btn";
      btn.style.backgroundImage = "none";
      btn.style.width = "auto";
      btn.style.margin = "0 4px";
      btn.style.padding = "0 8px";
      btn.style.fontSize = "12px";
      btn.style.fontWeight = "700";
      btn.textContent = "PDF";
      btn.setAttribute("aria-label", "Upload PDF");
      btn.addEventListener("click", function (event) {
        event.preventDefault();
        var input = document.createElement("input");
        input.type = "file";
        input.accept = "application/pdf,.pdf";
        input.addEventListener("change", function () {
          var file = input.files && input.files[0];
          if (!file) return;
          showStatus("Uploading PDF…", true);
          uploadFile(file)
            .then(function (data) {
              var label = (file.name || "document").replace(/\.pdf$/i, "");
              appendMarkdown("[" + label + "](" + data.location + ")");
              showStatus("PDF inserted — it renders as an inline viewer.", true);
            })
            .catch(function (err) {
              showStatus(typeof err === "string" ? err : "PDF upload failed.", false);
            });
        });
        input.click();
      });
      return btn;
    }

    function initToastEditor() {
      try {
        editor = new toastui.Editor({
          el: host,
          height: "480px",
          initialEditType: "wysiwyg",
          previewStyle: "vertical",
          theme: "dark",
          usageStatistics: false,
          initialValue: initialMd,
          placeholder: "Write in WYSIWYG or switch to Markdown…",
          hooks: {
            addImageBlobHook: function (blob, callback) {
              uploadFile(blob)
                .then(function (data) {
                  // Relative filename keeps the stored Markdown portable.
                  callback(data.location, "image");
                })
                .catch(function (err) {
                  showStatus(typeof err === "string" ? err : "Image upload failed.", false);
                });
            },
          },
          toolbarItems: [
            ["heading", "bold", "italic", "strike"],
            ["hr", "quote"],
            ["ul", "ol", "task", "indent", "outdent"],
            ["table", "image", "link"],
            ["code", "codeblock"],
            [{ el: pdfButton(), name: "pdf", tooltip: "Upload PDF (inline)" }],
          ],
        });
      } catch (err) {
        initFallback(err && err.message ? err.message : "init error");
      }
    }

    if (typeof toastui !== "undefined" && toastui.Editor) {
      initToastEditor();
    } else {
      var tries = 0;
      var timer = setInterval(function () {
        tries += 1;
        if (typeof toastui !== "undefined" && toastui.Editor) {
          clearInterval(timer);
          initToastEditor();
        } else if (tries >= 40) {
          clearInterval(timer);
          initFallback("editor bundle missing");
        }
      }, 50);
    }

    var slugTouched = !isNew;
    if (slugInput) {
      slugInput.addEventListener("input", function () { slugTouched = true; });
    }
    if (titleInput && slugInput && isNew) {
      titleInput.addEventListener("input", function () {
        if (!slugTouched) slugInput.value = slugify(titleInput.value);
      });
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!currentSlug()) {
        showStatus("URL slug is required.", false);
        return;
      }

      var markdown = getMarkdown();
      if (contentField) contentField.value = markdown;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
      }

      var body = new URLSearchParams();
      new FormData(form).forEach(function (value, key) {
        if (typeof value === "string") body.append(key, value);
      });
      body.set("content", markdown);

      fetch(form.getAttribute("action") || "/pages/save", {
        method: "POST",
        body: body,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "X-CSRF-Token": csrfToken,
        },
      })
        .then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok, data: data }; });
        })
        .then(function (result) {
          var data = result.data || {};
          if (result.ok && data.success) {
            showStatus(data.message || "Saved.", true);
            if (isNew && data.edit_url) {
              setTimeout(function () { window.location.href = data.edit_url; }, 500);
            }
          } else {
            showStatus(data.message || "Save failed.", false);
          }
        })
        .catch(function (err) {
          console.error(err);
          showStatus("Could not reach the server.", false);
        })
        .finally(function () {
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = "Save changes";
          }
        });
    });
  });
})();
