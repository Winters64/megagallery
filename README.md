# MEGA Galerie — prototype

Prototype web statique avec connexion MEGA via [megajs](https://github.com/qgustavor/mega), un SDK communautaire non officiel.

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

- La connexion MEGA sert à lister les dossiers et les photos/vidéos reconnues par leur extension. Faites glisser la souris dans la galerie pour sélectionner un groupe de médias ; une carte est retenue si le cadre couvre au moins 20 % de son aperçu. Ctrl/Cmd + clic permet aussi d’ajouter ou de retirer un média de la sélection. Les actions groupées sont accessibles par clic droit sur un média sélectionné ; cliquez droit sur un média non sélectionné pour n’agir que sur lui. Cliquez dans un espace vide de la galerie ou appuyez sur Échap pour désélectionner. Le déplacement propose une arborescence des dossiers ainsi qu’une recherche instantanée. Un clic droit sur un dossier de l’arborescence, dans la barre latérale ou dans le sélecteur de destination, permet de créer un sous-dossier, d’importer des fichiers, de renommer le dossier ou de le placer dans la corbeille MEGA avec son contenu. Un clic droit sur un espace vide de la zone centrale crée un dossier ou importe des fichiers dans le dossier actuellement ouvert, ou à la racine si aucun dossier n’est sélectionné. Le menu contextuel d’un dossier de la galerie permet également l’importation. Le menu contextuel d’un média permet de le renommer dans MEGA ; les actions groupées de renommage ne sont pas disponibles. Déplacements et suppressions demandent confirmation et sont appliqués directement au compte MEGA ; les éléments supprimés restent restaurables tant que la corbeille n’est pas vidée.
- La recherche, désormais placée dans l’en-tête fixe, parcourt tous les médias du drive MEGA connecté, y compris les noms de fichiers, les dossiers et les dates, sans se limiter au dossier actuellement ouvert. La galerie charge automatiquement les médias suivants à mesure que l’on approche du bas de la page. Sur ordinateur, l’arborescence latérale reste également fixe pendant le défilement du contenu central.
- Le mot de passe et le code 2FA sont saisis dans le navigateur, transmis à megajs (SDK communautaire non officiel), puis effacés du formulaire ; ils ne sont pas enregistrés. Pour restaurer la connexion après un rafraîchissement, la clé et le jeton de session MEGA sont conservés dans le `sessionStorage` de l’onglet, puis effacés lors de sa fermeture ou d’une déconnexion. Ces données donnent accès à la session : utiliser uniquement un appareil de confiance et une connexion HTTPS (ou `localhost` en développement).
- megajs ne fournissant pas ici de méthode de récupération des attributs de miniature, les miniatures sont créées dans le navigateur au défilement : 12 Mo max par image, 30 Mo par GIF animé, 100 Mo par vidéo pour générer une image fixe. Les vidéos compatibles avec le navigateur sont lues après un téléchargement temporaire, jusqu’à 100 Mo ; les photos jusqu’à 30 Mo. Ces aperçus consomment de la mémoire, surtout sur mobile. Les fichiers au-dessus des limites et les formats non pris en charge affichent un message explicite. Pour un fichier qui reste sans aperçu, vérifier son format et sa taille affichés dans la fiche.
- Les miniatures compressées (640 px maximum) sont conservées uniquement dans le cache local du navigateur (200 Mo maximum), séparément pour chaque compte. Les entrées les moins récemment utilisées sont supprimées automatiquement lorsque cette limite de taille est atteinte ; le cache n’a pas de limite fixe de nombre de miniatures. Les miniatures et leurs métadonnées d’éviction sont conservées séparément afin d’éviter de relire et réécrire les images lors d’un accès au cache. L’application demande au navigateur une protection durable du stockage IndexedDB afin qu’il ne soit pas nettoyé automatiquement ; le navigateur conserve la décision finale. Le cache accélère le réaffichage des miniatures déjà consultées, mais ne rend pas les médias disponibles si MEGA est hors ligne et n’est partagé ni entre appareils ni entre navigateurs. « Vider le cache local » efface IndexedDB sur cet appareil ; le navigateur peut également supprimer ces données selon ses propres règles de stockage. Aucune miniature n’est créée, envoyée ou supprimée dans MEGA par la fonctionnalité de cache ; d’éventuels anciens fichiers de cache déjà présents dans MEGA ne sont pas modifiés automatiquement.
- L’intégration actuelle via megajs récupère l’arborescence des dossiers et les médias qu’ils contiennent, mais pas les albums virtuels natifs de MEGA. La barre latérale ne présente donc que les dossiers ; quand on ouvre un dossier, ses ancêtres se déplient automatiquement et le fil d’Ariane cliquable permet de revenir à un dossier parent ou à la racine. Ses sous-dossiers apparaissent également dans la zone centrale sous forme de cartes au même format que les médias, avec une couverture issue d’une photo du dossier ou de ses descendants. Les dossiers sans média utilisent une icône de remplacement. Avant connexion, les dossiers affichés sont des exemples.
- Les dossiers MEGA sont triés alphabétiquement à chaque niveau de l’arborescence, repliée par défaut. Le séparateur à droite du panneau latéral peut être glissé pour ajuster sa largeur ; les flèches gauche/droite du clavier permettent aussi de la régler. La largeur est mémorisée dans le navigateur.
- Les éléments affichés avant connexion sont des exemples et sont conservés localement dans le navigateur.
- Le mode de repli réel lorsque MEGA est indisponible n’est pas implémenté.
