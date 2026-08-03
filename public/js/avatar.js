/**
 * Rescale a chosen profile picture to exactly 100×100 before the form is sent,
 * so the server stores a small square regardless of what was picked.
 *
 * Centre-cropped with a canvas, exported as PNG, and swapped back into the file
 * input via DataTransfer. If any of that is unavailable the original file is
 * uploaded unchanged (the server still bounds and validates it) and CSS keeps
 * the display square.
 */
(function () {
  "use strict";

  var SIZE = 100;

  function resize(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        try {
          var canvas = document.createElement("canvas");
          canvas.width = SIZE;
          canvas.height = SIZE;
          var ctx = canvas.getContext("2d");

          // Cover: crop the longer edge so the square is never distorted.
          var side = Math.min(img.naturalWidth, img.naturalHeight);
          var sx = (img.naturalWidth - side) / 2;
          var sy = (img.naturalHeight - side) / 2;
          ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);

          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error("canvas produced no image"));
          }, "image/png");
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("could not decode image"));
      };
      img.src = url;
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var input = document.querySelector("input[data-avatar-input]");
    if (!input || typeof DataTransfer === "undefined") return;
    var form = input.form;
    if (!form) return;

    var resized = false;

    form.addEventListener("submit", function (event) {
      var file = input.files && input.files[0];
      if (resized || !file || !/^image\//.test(file.type)) return;

      event.preventDefault();
      resize(file)
        .then(function (blob) {
          var transfer = new DataTransfer();
          transfer.items.add(new File([blob], "avatar.png", { type: "image/png" }));
          input.files = transfer.files;
        })
        .catch(function (err) {
          console.warn("Avatar resize skipped:", err.message);
        })
        .finally(function () {
          resized = true;
          form.submit();
        });
    });

    // Live preview of the picked file.
    input.addEventListener("change", function () {
      resized = false;
      var file = input.files && input.files[0];
      var preview = form.querySelector(".avatar-preview");
      if (!file || !preview || preview.tagName !== "IMG") return;
      preview.src = URL.createObjectURL(file);
    });
  });
})();
