/*
 * Armazenamento. Dois modos, mesma interface:
 *  - local:  tudo fica neste aparelho (IndexedDB + localStorage);
 *  - server: fotos, músicas e ajustes ficam no servidor (server.js) e são
 *            compartilhados entre todos os aparelhos da rede.
 */
(function () {
  'use strict';

  var PR = (window.PR = window.PR || {});
  var CLIENT_ID = Math.random().toString(36).slice(2, 10);

  function newId() {
    return Date.now().toString(36) + (Math.random().toString(36) + '000000').slice(2, 8);
  }

  /* ---------------- modo local (IndexedDB) ---------------- */

  function createLocal() {
    var db = null;
    var thumbUrls = {};

    function open() {
      return new Promise(function (resolve, reject) {
        if (!window.indexedDB) return reject(new Error('IndexedDB indisponível'));
        var req = indexedDB.open('porta-retrato', 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          d.createObjectStore('photos', { keyPath: 'id' });
          d.createObjectStore('photoData');
          d.createObjectStore('music', { keyPath: 'id' });
          d.createObjectStore('musicData');
        };
        req.onsuccess = function () {
          db = req.result;
          resolve();
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    }

    // Executa `fn(tx)` em uma transação; resolve com o resultado do pedido devolvido por fn.
    function run(stores, mode, fn) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(stores, mode);
        var req = fn(tx);
        tx.oncomplete = function () {
          resolve(req ? req.result : undefined);
        };
        tx.onerror = tx.onabort = function () {
          reject(tx.error || new Error('Falha ao gravar'));
        };
      });
    }

    function blobUrl(store, id) {
      return run([store], 'readonly', function (tx) {
        return tx.objectStore(store).get(id);
      }).then(function (blob) {
        if (!blob) throw new Error('Arquivo não encontrado');
        var url = URL.createObjectURL(blob);
        return {
          url: url,
          release: function () {
            URL.revokeObjectURL(url);
          },
        };
      });
    }

    return {
      mode: 'local',
      info: null,
      init: function () {
        return open().then(function () {
          // Pede ao navegador para não apagar as fotos quando faltar espaço.
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
        });
      },

      listPhotos: function () {
        return run(['photos'], 'readonly', function (tx) {
          return tx.objectStore('photos').getAll();
        });
      },
      addPhoto: function (meta, full, thumb) {
        var rec = { id: newId(), name: meta.name, date: meta.date, w: meta.w, h: meta.h, thumb: thumb };
        return run(['photos', 'photoData'], 'readwrite', function (tx) {
          tx.objectStore('photoData').put(full, rec.id);
          tx.objectStore('photos').put(rec);
        });
      },
      deletePhoto: function (id) {
        if (thumbUrls[id]) {
          URL.revokeObjectURL(thumbUrls[id]);
          delete thumbUrls[id];
        }
        return run(['photos', 'photoData'], 'readwrite', function (tx) {
          tx.objectStore('photos').delete(id);
          tx.objectStore('photoData').delete(id);
        });
      },
      thumbUrl: function (photo) {
        if (!thumbUrls[photo.id]) thumbUrls[photo.id] = URL.createObjectURL(photo.thumb);
        return thumbUrls[photo.id];
      },
      photoUrl: function (photo) {
        return blobUrl('photoData', photo.id);
      },

      listMusic: function () {
        return run(['music'], 'readonly', function (tx) {
          return tx.objectStore('music').getAll();
        });
      },
      addMusic: function (file, name) {
        var rec = { id: newId(), name: name, type: file.type || 'audio/mpeg' };
        return run(['music', 'musicData'], 'readwrite', function (tx) {
          tx.objectStore('musicData').put(file, rec.id);
          tx.objectStore('music').put(rec);
        });
      },
      deleteMusic: function (id) {
        return run(['music', 'musicData'], 'readwrite', function (tx) {
          tx.objectStore('music').delete(id);
          tx.objectStore('musicData').delete(id);
        });
      },
      musicUrl: function (track) {
        return blobUrl('musicData', track.id);
      },

      getSettings: function () {
        try {
          return Promise.resolve(JSON.parse(localStorage.getItem('pr.settings')) || {});
        } catch (e) {
          return Promise.resolve({});
        }
      },
      saveSettings: function (settings) {
        try {
          localStorage.setItem('pr.settings', JSON.stringify(settings));
        } catch (e) {}
        return Promise.resolve();
      },

      sendCommand: function () {
        return Promise.resolve();
      },
      onEvent: function () {},
    };
  }

  /* ---------------- modo servidor ---------------- */

  function createRemote(info) {
    function api(method, url, body, type) {
      var opts = { method: method, cache: 'no-store' };
      if (body !== undefined) {
        opts.body = body;
        if (type) opts.headers = { 'Content-Type': type };
      }
      return fetch(url, opts).then(function (r) {
        if (!r.ok) throw new Error('Servidor respondeu ' + r.status);
        return r.json();
      });
    }

    function fixed(url) {
      return Promise.resolve({ url: url, release: function () {} });
    }

    function qs(params) {
      return Object.keys(params)
        .map(function (k) {
          return k + '=' + encodeURIComponent(params[k]);
        })
        .join('&');
    }

    return {
      mode: 'server',
      info: info,
      init: function () {
        return Promise.resolve();
      },

      listPhotos: function () {
        return api('GET', 'api/photos');
      },
      addPhoto: function (meta, full, thumb) {
        var id = newId();
        // A miniatura vai primeiro: a foto só entra na lista quando está completa.
        return api('PUT', 'api/thumbs/' + id, thumb, 'image/jpeg').then(function () {
          return api('PUT', 'api/photos/' + id + '?' + qs(meta), full, 'image/jpeg');
        });
      },
      deletePhoto: function (id) {
        return api('DELETE', 'api/photos/' + id);
      },
      thumbUrl: function (photo) {
        return 'media/thumbs/' + photo.id + '.jpg';
      },
      photoUrl: function (photo) {
        return fixed('media/photos/' + photo.id + '.jpg');
      },

      listMusic: function () {
        return api('GET', 'api/music');
      },
      addMusic: function (file, name) {
        var type = file.type || 'audio/mpeg';
        return api('PUT', 'api/music/' + newId() + '?' + qs({ name: name, type: type }), file, type);
      },
      deleteMusic: function (id) {
        return api('DELETE', 'api/music/' + id);
      },
      musicUrl: function (track) {
        return fixed('media/music/' + track.id);
      },

      getSettings: function () {
        return api('GET', 'api/settings');
      },
      saveSettings: function (settings) {
        return api('PUT', 'api/settings?from=' + CLIENT_ID, JSON.stringify(settings), 'application/json');
      },

      sendCommand: function (action) {
        return api('POST', 'api/command', JSON.stringify({ action: action, from: CLIENT_ID }), 'application/json');
      },

      /**
       * Avisos do servidor: {type:'library'|'music'|'settings'|'command'|'reconnect'}.
       * Ajustes e comandos enviados por este próprio aparelho são ignorados.
       */
      onEvent: function (cb) {
        if (!window.EventSource) return;
        var es = new EventSource('api/events');
        var dropped = false;
        es.onmessage = function (e) {
          var ev;
          try {
            ev = JSON.parse(e.data);
          } catch (err) {
            return;
          }
          if (ev.from && ev.from === CLIENT_ID) return;
          cb(ev);
        };
        es.onerror = function () {
          dropped = true;
        };
        es.onopen = function () {
          if (dropped) cb({ type: 'reconnect' });
          dropped = false;
        };
      },
    };
  }

  /* ---------------- detecção ---------------- */

  function detectServer() {
    var timeout = new Promise(function (resolve) {
      setTimeout(function () {
        resolve(null);
      }, 4000);
    });
    var probe = fetch('api/info', { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (info) {
        return info && info.app === 'porta-retrato' ? info : null;
      })
      .catch(function () {
        return null;
      });
    return Promise.race([probe, timeout]);
  }

  /** Resolve com o armazenamento pronto para uso. */
  PR.createStore = function () {
    return detectServer().then(function (info) {
      var store = info ? createRemote(info) : createLocal();
      return store.init().then(function () {
        return store;
      });
    });
  };
})();
