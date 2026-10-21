# Extension Firefox — Vinted HEIC Importer + panneau Detniv

Extension MV3 pour Firefox : conversion HEIC/HEIF, amélioration des photos,
et panneau Detniv (connexion, création d'annonce, republication).

## Arborescence

```
extension-firefox/
├── manifest.json
├── background/                 # Service worker (lecture cookies HttpOnly)
│   └── background.js
├── api/                        # Client HTTP Detniv (session, auth, templates)
│   └── api.js
├── lib/                        # Bibliothèques réutilisables, sans UI
│   ├── heic-to.js              # Décodeur HEIC/HEIF (WASM, vendorisé)
│   └── enhance.js              # Pipeline d'amélioration d'image (canvas, pur)
├── page/                       # Monde page (injecté dans le contexte Vinted)
│   └── bridge.js               # Pont React / réseau de la page (postMessage)
├── features/
│   ├── heic/                   # Import HEIC sur les inputs Vinted
│   │   └── heic-import.js
│   ├── creation/               # Formulaire « Vends ton article »
│   │   ├── wand.js             # Baguette magique (amélioration des photos)
│   │   └── form-tools.js       # Description, hashtags, modèles Detniv
│   └── republication/          # Garde-robe : rechargement paginé via l'API
│       └── repost.js
├── panel/                      # Panneau Detniv (sidebar / tiroir mobile)
│   └── panel.js
├── popup/                      # Popup de réglages de conversion
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── icons/
├── tools/
│   └── generate_icons.py
└── test/                       # Suites Node/jsdom
    ├── sources.js              # Chemins des sources (point unique)
    ├── all.js                  # Lance toutes les suites
    ├── manifest-tests.js
    ├── api-tests.js
    ├── dom-tests.js
    ├── form-tools-tests.js
    ├── panel-tests.js
    ├── repost-tests.js
    └── run-tests.js
```

## Dépendances entre modules

| Module | Dépend de |
| --- | --- |
| `features/heic/heic-import.js` | `lib/heic-to.js` |
| `features/creation/wand.js` | `lib/enhance.js`, `page/bridge.js` |
| `features/creation/form-tools.js` | `api/api.js` |
| `features/republication/repost.js` | API Vinted (fetch paginé) |
| `panel/panel.js` | `api/api.js`, `features/republication/repost.js` |

L'ordre de chargement des content scripts est défini dans `manifest.json`
(bibliothèques → API → fonctionnalités → panneau). Les modules exposent leurs
globals (`DetnivApi`, `DetnivEnhance`, `DetnivRepost`) au moment de leur
exécution ; le panneau est chargé en dernier.

## Tests

```bash
cd extension-firefox
npm i --no-save jsdom          # requis par les suites DOM
node test/all.js               # toutes les suites
```

Ou suite par suite :

```bash
node test/manifest-tests.js
node test/api-tests.js
node test/run-tests.js
node test/dom-tests.js
node test/form-tools-tests.js
node test/repost-tests.js
node test/panel-tests.js
```

`test/sources.js` centralise les chemins : en cas de déplacement d'un module,
seule cette table (et `manifest.json`) est à mettre à jour.

## Chargement dans Firefox

`about:debugging` → « Ce Firefox » → « Charger un module temporaire » →
sélectionner `manifest.json`.

## Icônes

```bash
python3 tools/generate_icons.py
```

Les PNG sont écrits dans `icons/`.
