# MEGA Galerie — prototype

Prototype web statique avec connexion MEGA en lecture seule via [megajs](https://github.com/qgustavor/mega), un SDK communautaire non officiel.

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

- La connexion MEGA sert à lister les dossiers et les photos/vidéos reconnues par leur extension.
- Le compte réel est parcouru en lecture seule : aucune opération de renommage, déplacement, suppression, ajout de favori ou téléversement n’est envoyée à MEGA.
- Le mot de passe et le code 2FA sont saisis dans le navigateur, transmis à megajs (SDK communautaire non officiel), puis effacés du formulaire ; ils ne sont pas enregistrés. Pour restaurer la connexion après un rafraîchissement, la clé et le jeton de session MEGA sont conservés dans le `sessionStorage` de l’onglet, puis effacés lors de sa fermeture ou d’une déconnexion. Ces données donnent accès à la session : utiliser uniquement un appareil de confiance et une connexion HTTPS (ou `localhost` en développement).
- megajs ne fournissant pas ici de méthode de récupération des attributs de miniature, les miniatures sont créées dans le navigateur au défilement : 12 Mo max par image, 30 Mo par GIF animé, 100 Mo par vidéo pour générer une image fixe. Les vidéos compatibles avec le navigateur sont lues après un téléchargement temporaire, jusqu’à 100 Mo ; les photos jusqu’à 30 Mo. Ces aperçus consomment de la mémoire, surtout sur mobile. Les fichiers au-dessus des limites et les formats non pris en charge affichent un message explicite. Pour un fichier qui reste sans aperçu, vérifier son format et sa taille affichés dans la fiche.
- Les aperçus MEGA téléchargés sont conservés dans IndexedDB sur l’appareil, séparément pour chaque compte, avec une limite de 200 Mo et 400 entrées. Les entrées les moins récemment utilisées sont supprimées automatiquement lorsque cette limite est atteinte. Le cache permet de réafficher plus vite les aperçus déjà consultés, mais ne rend pas les médias disponibles si MEGA est hors ligne : il ne s’agit pas d’une copie locale complète. Utiliser « Vider le cache enregistré » pour effacer ces données ; le navigateur peut également les supprimer selon ses propres règles de stockage.
- L’intégration actuelle via megajs récupère l’arborescence des dossiers et les médias qu’ils contiennent, mais pas les albums virtuels natifs de MEGA. La barre latérale ne présente donc que les dossiers ; avant connexion, ceux affichés sont des exemples.
- Les dossiers MEGA sont présentés sous forme d’arborescence, repliée par défaut ; chaque niveau peut être déplié ou replié avec sa flèche.
- Les éléments affichés avant connexion sont des exemples et sont conservés localement dans le navigateur.
- La synchronisation, le mode de repli réel et l’écriture MEGA ne sont pas implémentés.
