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

- La connexion MEGA sert à lister les dossiers et les photos/vidéos reconnues par leur extension. Faites glisser la souris dans la galerie pour sélectionner un groupe de médias ; une carte est retenue si le cadre couvre au moins 20 % de son aperçu. Ctrl/Cmd + clic permet aussi d’ajouter ou de retirer un média de la sélection. Les actions groupées sont accessibles par clic droit sur un média sélectionné ; cliquez droit sur un média non sélectionné pour n’agir que sur lui. Cliquez dans un espace vide de la galerie ou appuyez sur Échap pour désélectionner. Le déplacement propose une arborescence des dossiers ainsi qu’une recherche instantanée. Déplacements et suppressions demandent confirmation et sont appliqués directement au compte MEGA ; une suppression place les médias dans la corbeille MEGA, où ils restent restaurables tant que celle-ci n’est pas vidée.
- Les opérations de renommage et de téléversement ne sont pas implémentées.
- Le mot de passe et le code 2FA sont saisis dans le navigateur, transmis à megajs (SDK communautaire non officiel), puis effacés du formulaire ; ils ne sont pas enregistrés. Pour restaurer la connexion après un rafraîchissement, la clé et le jeton de session MEGA sont conservés dans le `sessionStorage` de l’onglet, puis effacés lors de sa fermeture ou d’une déconnexion. Ces données donnent accès à la session : utiliser uniquement un appareil de confiance et une connexion HTTPS (ou `localhost` en développement).
- megajs ne fournissant pas ici de méthode de récupération des attributs de miniature, les miniatures sont créées dans le navigateur au défilement : 12 Mo max par image, 30 Mo par GIF animé, 100 Mo par vidéo pour générer une image fixe. Les vidéos compatibles avec le navigateur sont lues après un téléchargement temporaire, jusqu’à 100 Mo ; les photos jusqu’à 30 Mo. Ces aperçus consomment de la mémoire, surtout sur mobile. Les fichiers au-dessus des limites et les formats non pris en charge affichent un message explicite. Pour un fichier qui reste sans aperçu, vérifier son format et sa taille affichés dans la fiche.
- Les aperçus MEGA téléchargés sont conservés dans IndexedDB sur l’appareil, séparément pour chaque compte, avec une limite de 200 Mo et 400 entrées. Les entrées les moins récemment utilisées sont supprimées automatiquement lorsque cette limite est atteinte. Le cache permet de réafficher plus vite les aperçus déjà consultés, mais ne rend pas les médias disponibles si MEGA est hors ligne : il ne s’agit pas d’une copie locale complète. Utiliser « Vider le cache enregistré » pour effacer ces données ; le navigateur peut également les supprimer selon ses propres règles de stockage.
- L’intégration actuelle via megajs récupère l’arborescence des dossiers et les médias qu’ils contiennent, mais pas les albums virtuels natifs de MEGA. La barre latérale ne présente donc que les dossiers ; quand on ouvre un dossier, ses sous-dossiers apparaissent également dans la zone centrale sous forme de cartes au même format que les médias, avec une couverture issue d’une photo du dossier ou de ses descendants. Les dossiers sans média utilisent une icône de remplacement. Avant connexion, les dossiers affichés sont des exemples.
- Les dossiers MEGA sont triés alphabétiquement à chaque niveau de l’arborescence, repliée par défaut. Le séparateur à droite du panneau latéral peut être glissé pour ajuster sa largeur ; les flèches gauche/droite du clavier permettent aussi de la régler. La largeur est mémorisée dans le navigateur.
- Les éléments affichés avant connexion sont des exemples et sont conservés localement dans le navigateur.
- La synchronisation complète et le mode de repli réel ne sont pas implémentés.
