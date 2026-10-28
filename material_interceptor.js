/**
 * material_interceptor.js
 *
 * Этот скрипт выполняется в MAIN-мире страницы (world: "MAIN").
 * Его задача — перехватывать запросы на регистрацию материалов
 * (POST /api/materials/v3/materials/register) и передавать
 * полученные материалы в content.js (isolated world) через window.postMessage.
 *
 * Дополнительная фича: не влияет на основную логику добавления материала.
 */
(function () {
  const TARGET = '/api/materials/v3/materials/register';
  const SOURCE = 'MESH_MATERIAL_TRACKER';

  function postMaterials(materials) {
    try {
      if (!Array.isArray(materials) || materials.length === 0) return;
      window.postMessage(
        { source: SOURCE, type: 'registered', materials: materials },
        '*'
      );
    } catch (e) {
      /* ignore */
    }
  }

  function isTarget(url) {
    return typeof url === 'string' && url.indexOf(TARGET) !== -1;
  }

  // --- Перехват fetch ---
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function () {
      const args = arguments;
      const promise = originalFetch.apply(this, args);
      try {
        const request = args[0];
        const url = typeof request === 'string' ? request : (request && request.url) || '';
        if (isTarget(url)) {
          promise.then(function (response) {
            try {
              response
                .clone()
                .json()
                .then(function (data) {
                  if (data && Array.isArray(data.materials)) {
                    postMaterials(data.materials);
                  }
                })
                .catch(function () {});
            } catch (e) {
              /* ignore */
            }
          }).catch(function () {});
        }
      } catch (e) {
        /* ignore */
      }
      return promise;
    };
  }

  // --- Перехват XMLHttpRequest ---
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__mes_tracker_url = url;
    } catch (e) {
      /* ignore */
    }
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    try {
      if (isTarget(this.__mes_tracker_url)) {
        const xhr = this;
        xhr.addEventListener('load', function () {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data && Array.isArray(data.materials)) {
              postMaterials(data.materials);
            }
          } catch (e) {
            /* ignore */
          }
        });
      }
    } catch (e) {
      /* ignore */
    }
    return originalSend.apply(this, arguments);
  };
})();
