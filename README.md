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

## Déploiement Free.fr depuis VS Code

1. Installer l’extension recommandée **SFTP** (`Natizyskunk.sftp`) depuis la vue Extensions de VS Code.
2. Ouvrir `.vscode/sftp.json` et renseigner `username` avec l’identifiant FTP Free. Le mot de passe n’est pas enregistré dans le fichier : l’extension le demande lors de la connexion.
3. La configuration vise le sous-dossier `megagallery` (`http://winters64.free.fr/megagallery`). Si ce dossier n’existe pas encore côté FTP, le créer d’abord ; si le compte présente une racine FTP différente, adapter `remotePath` en conséquence.
4. Lancer `npm run build`, puis utiliser la commande d’envoi de dossier de l’extension sur `dist/`. La configuration limite les transferts à `dist/`, désactive l’envoi automatique à chaque sauvegarde, et évite d’envoyer le code source.

Le fichier `.vscode/sftp.json` est ignoré par Git pour éviter d’y conserver des données de compte ; le modèle sans identifiant personnel est dans `.vscode/sftp.json.example`. Free utilise le FTP classique (port 21, sans chiffrement) : les identifiants transitent sans protection. Effectuer le transfert uniquement sur un réseau de confiance et ne jamais partager le mot de passe.

### Déploiement automatique depuis GitHub

Le workflow `.github/workflows/deploy-free.yml` construit le site et publie le contenu de `dist/` dans `/megagallery/` après chaque push sur `master` (ou manuellement depuis l’onglet Actions). Dans les paramètres du dépôt GitHub, ajouter les secrets d’Actions `FREE_FTP_USERNAME` et `FREE_FTP_PASSWORD`. Le premier déploiement échouera tant que ces secrets ne sont pas définis. Le workflow utilise FTP classique, sans chiffrement ; les identifiants doivent uniquement être enregistrés comme secrets GitHub, jamais dans le dépôt.

L’URL actuelle `http://winters64.free.fr/megagallery` est en HTTP. L’API Web Crypto utilisée par megajs pour se connecter à MEGA n’est disponible que dans un contexte sécurisé (HTTPS ou `localhost`) ; la connexion MEGA est donc bloquée sur cette URL, et il ne faut pas y saisir ses identifiants. Il faut un hébergement HTTPS pour utiliser MEGA en ligne.

## Connexion et limites de ce POC

- La connexion MEGA sert à lister les dossiers et les photos/vidéos reconnues par leur extension.
- Le compte réel est parcouru en lecture seule : aucune opération de renommage, déplacement, suppression, ajout de favori ou téléversement n’est envoyée à MEGA.
- Le mot de passe et le code 2FA sont saisis dans le navigateur, transmis à megajs (SDK communautaire non officiel), puis effacés du formulaire ; ils ne sont pas enregistrés. Pour restaurer la connexion après un rafraîchissement, la clé et le jeton de session MEGA sont conservés dans le `sessionStorage` de l’onglet, puis effacés lors de sa fermeture ou d’une déconnexion. Ces données donnent accès à la session : utiliser uniquement un appareil de confiance et une connexion HTTPS (ou `localhost` en développement).
- megajs ne fournissant pas ici de méthode de récupération des attributs de miniature, les miniatures sont créées dans le navigateur au défilement : 12 Mo max par image, 30 Mo par GIF animé, 100 Mo par vidéo pour générer une image fixe. Les vidéos compatibles avec le navigateur sont lues après un téléchargement temporaire, jusqu’à 100 Mo ; les photos jusqu’à 30 Mo. Ces aperçus consomment de la mémoire, surtout sur mobile. Les fichiers au-dessus des limites et les formats non pris en charge affichent un message explicite. Pour un fichier qui reste sans aperçu, vérifier son format et sa taille affichés dans la fiche.
- Les aperçus MEGA téléchargés sont conservés dans IndexedDB sur l’appareil, séparément pour chaque compte, avec une limite de 200 Mo et 400 entrées. Les entrées les moins récemment utilisées sont supprimées automatiquement lorsque cette limite est atteinte. Le cache permet de réafficher plus vite les aperçus déjà consultés, mais ne rend pas les médias disponibles si MEGA est hors ligne : il ne s’agit pas d’une copie locale complète. Utiliser « Vider le cache enregistré » pour effacer ces données ; le navigateur peut également les supprimer selon ses propres règles de stockage.
- L’intégration actuelle via megajs récupère l’arborescence des dossiers et les médias qu’ils contiennent, mais pas les albums virtuels natifs de MEGA. La barre latérale ne présente donc que les dossiers ; avant connexion, ceux affichés sont des exemples.
- Les dossiers MEGA sont présentés sous forme d’arborescence, repliée par défaut ; chaque niveau peut être déplié ou replié avec sa flèche.
- Les éléments affichés avant connexion sont des exemples et sont conservés localement dans le navigateur.
- Le miroir Free.fr, la synchronisation, le mode de repli réel et l’écriture MEGA ne sont pas implémentés.
