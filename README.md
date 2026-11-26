# MEGA Galerie

Application web statique avec connexion MEGA via [megajs](https://github.com/qgustavor/mega), un SDK communautaire non officiel. Sans session active, la page d’accueil affiche uniquement le formulaire de connexion MEGA ; la galerie et les dossiers s’affichent après connexion.

## Lancer en local

Prérequis : Node.js 20.19+ et npm.

```sh
npm install
npm run dev
```

Ouvrir l’URL locale affichée par Vite. Ne pas ouvrir `index.html` directement avec `file://` : le navigateur doit charger le module et les dépendances via le serveur de développement.

Pour générer les fichiers statiques :

```sh
npm run build
```

Le contenu de `dist/` est le livrable à héberger. Le prototype ne nécessite ni PHP ni base de données.

## Déploiement GitHub Pages

Le workflow `.github/workflows/deploy-pages.yml` construit le site et publie `dist/` à chaque push sur `master`. Aucun secret FTP ni autre secret de déploiement n’est nécessaire. Après le premier déploiement, le site sera disponible à l’adresse `https://winters64.github.io/megagallery/`.

Le dépôt source reste privé, mais le site publié sur GitHub Pages peut être accessible publiquement. GitHub Pages avec un dépôt privé dépend de l’offre du compte ; si l’activation est refusée, il faudra soit rendre le dépôt public, soit utiliser une offre GitHub qui autorise Pages pour les dépôts privés. Le build utilise `/megagallery/` comme base pour cette URL de projet.

## Connexion et limites de ce POC

- La gestion des tags est disponible pour les photos et vidéos depuis leur menu contextuel. Les tags sont enregistrés dans l’attribut MEGA natif `t` (séparateur virgule, maximum 10 tags), affichés sous le média et inclus dans la recherche. L’entrée « Tags » de la barre latérale ouvre une grille de cartes avec couverture et nombre de médias ; ouvrir une carte filtre la galerie. La fenêtre de gestion permet de retirer ou d’ajouter des tags et de réutiliser les tags existants via l’autocomplétion. Avec plusieurs médias sélectionnés, elle permet d’ajouter un tag à toute la sélection ou de le retirer de chaque média sélectionné qui le possède, sans modifier les autres tags. Les limites MEGA sont vérifiées média par média et les éventuels échecs partiels sont signalés. La relecture depuis MEGA est vérifiée après chaque modification. L’écriture utilise `setAttributes` de megajs, qui n’expose pas encore de méthode dédiée aux tags.
- La connexion MEGA sert à lister les dossiers et les photos/vidéos reconnues par leur extension. Faites glisser la souris dans la galerie pour sélectionner un groupe de médias ; une carte est retenue si le cadre couvre au moins 20 % de son aperçu. Ctrl/Cmd + clic permet aussi d’ajouter ou de retirer un média de la sélection. Les actions (tags, renommage, déplacement, favoris, suppression) sont accessibles par clic droit sur une carte, via le bouton `⋯` de la carte ou directement depuis les boutons dédiés de la visionneuse plein écran ; cliquez droit sur un média sélectionné pour agir sur toute la sélection. Cliquez dans un espace vide de la galerie ou appuyez sur Échap pour désélectionner. L’entrée « Dossiers » de la barre latérale ouvre les dossiers sous forme de cartes ; le déplacement propose une arborescence des dossiers ainsi qu’une recherche instantanée. Un clic droit sur un dossier permet de créer un sous-dossier, d’importer des fichiers, de le renommer ou de le placer dans la corbeille MEGA avec son contenu (et, depuis la corbeille, de le restaurer dans Mon Drive ou de le supprimer définitivement). Un clic droit sur un espace vide de la zone centrale crée un dossier ou importe des fichiers dans le dossier actuellement ouvert, ou à la racine si aucun dossier n’est sélectionné. Les suppressions demandent confirmation et distinguent clairement la mise à la corbeille de la suppression définitive irréversible.
- Après un envoi, un déplacement ou une modification de dossier, l’application actualise la bibliothèque depuis MEGA et réessaie brièvement si la modification distante tarde à apparaître. Le bouton « Synchroniser depuis MEGA » dans l’en-tête permet de forcer une actualisation ; une notification indique si elle échoue ou si le changement n’est pas encore confirmé.
- La recherche, placée dans l’en-tête fixe, parcourt tous les médias du drive MEGA connecté, y compris les noms de fichiers, les dossiers et les dates, sans se limiter au dossier actuellement ouvert. Dans les vues « Dossiers » et « Tags », elle filtre les cartes par nom. La galerie charge automatiquement les médias suivants à mesure que l’on approche du bas de la page.
- Le mot de passe et le code 2FA sont saisis dans le navigateur, transmis à megajs (SDK communautaire non officiel), puis effacés du formulaire ; ils ne sont pas enregistrés. Pour restaurer la connexion après un rafraîchissement, la clé et le jeton de session MEGA sont conservés dans le `sessionStorage` de l’onglet, puis effacés lors de sa fermeture ou d’une déconnexion. Ces données donnent accès à la session : utiliser uniquement un appareil de confiance et une connexion HTTPS (ou `localhost` en développement).
- Pour accélérer l’affichage sans aucun cache persistant sur l’appareil, l’application récupère d’abord les miniatures et aperçus natifs déjà associés aux fichiers dans MEGA (`fa` / `ufa`), avec priorisation des éléments visibles à l’écran, décodage asynchrone et conservation uniquement en mémoire vive le temps de la session. Ces aperçus sont stockés avec les médias dans le compte MEGA et évitent de télécharger le fichier complet. Si un fichier ne possède pas d’aperçu MEGA natif, l’application génère une miniature de repli dans le navigateur : 12 Mo max par image, 30 Mo par GIF animé, 100 Mo par vidéo. En plein écran, l’aperçu MEGA est affiché immédiatement pendant le chargement de la photo haute définition (jusqu’à 30 Mo ; au-delà, l’aperçu optimisé MEGA reste affiché) et les médias voisins sont préchargés. Les vidéos compatibles avec le navigateur sont lues après un téléchargement temporaire jusqu’à 100 Mo. Les fichiers sans aperçu au-dessus des limites et les formats non pris en charge affichent un message explicite.
- L’intégration actuelle via megajs récupère l’arborescence des dossiers et les médias qu’ils contiennent, mais pas les albums virtuels natifs de MEGA. L’entrée « Dossiers » ouvre les dossiers de premier niveau sous forme de cartes ; leurs sous-dossiers apparaissent aussi comme des cartes quand on ouvre un dossier. Les couvertures proviennent d’une photo du dossier ou de ses descendants ; les dossiers sans média utilisent une icône de remplacement. Le fil d’Ariane cliquable permet de revenir à un dossier parent ou à l’index des dossiers. La galerie n’est accessible qu’après connexion à MEGA.
- Les dossiers MEGA sont triés alphabétiquement à chaque niveau. Le séparateur à droite du panneau latéral peut être glissé pour ajuster sa largeur ; les flèches gauche/droite du clavier permettent aussi de la régler. La largeur est mémorisée dans le navigateur.
- Le mode de repli réel lorsque MEGA est indisponible n’est pas implémenté.
