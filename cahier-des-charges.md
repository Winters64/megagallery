# Cahier des charges — Galerie photo et vidéo MEGA

## 1. Objectif

Créer une application web privée et responsive pour parcourir et organiser les photos et vidéos de mon drive MEGA.

L’application doit utiliser l’API MEGA pour accéder au drive et en refléter la structure. Elle doit également pouvoir afficher une copie des médias présents sur mon hébergement personnel Free.fr lorsque l’API MEGA est indisponible.

## 2. Utilisateur et environnement

- Utilisateur : moi seul.
- Hébergement visé : page personnelle Free.fr.
- Technologie : éviter PHP.
- Volume estimé : jusqu’à 50 Go de médias.
- Accès : ordinateur et mobile, via fibre ou réseau 5G.
- Base de données : aucune pour la première version. Réévaluer ce besoin si l’API MEGA ne couvre pas certaines fonctionnalités.

## 3. Accès à MEGA et miroir sur le serveur

- Utiliser l’API MEGA pour parcourir et gérer le contenu du drive.
- Reproduire sur le serveur Free.fr la structure des dossiers ainsi que les photos et vidéos nécessaires au mode de repli.
- Synchroniser la structure et le contenu entre MEGA et le serveur, dans les deux sens.
- Si l’API MEGA est indisponible, afficher les médias déjà téléchargés sur le serveur.
- Lorsque MEGA redevient disponible, reprendre la synchronisation et répercuter les changements en attente.

## 4. Fonctionnalités

### Consultation

- Parcourir les dossiers et médias selon l’organisation du drive MEGA.
- Afficher les photos sous forme de galerie et en plein écran.
- Lire les vidéos.
- Lancer un diaporama.
- Adapter l’interface aux écrans mobiles.

### Organisation et gestion

- Créer et consulter des albums.
- Ajouter ou retirer des favoris.
- Rechercher et filtrer les médias, notamment par nom, date ou type, selon les informations disponibles.
- Ajouter, déplacer, renommer et supprimer des médias depuis l’application, en répercutant les opérations dans MEGA et dans le miroir serveur.

## 5. Contraintes et points de faisabilité

- Vérifier les possibilités techniques de l’hébergement Free.fr pour exécuter l’application et maintenir le miroir à jour, sans PHP.
- Vérifier les possibilités et limites de l’API MEGA pour les opérations de consultation, de gestion et de synchronisation.
- Ne jamais intégrer les identifiants MEGA au code source ni les enregistrer dans l’application. Si la connexion est faite dans le navigateur avec megajs, les identifiants y sont nécessairement traités en mémoire ; cette approche doit être utilisée sur un appareil de confiance et sur une origine HTTPS.
- Prévoir une gestion explicite des erreurs d’accès à MEGA et de synchronisation.

## 6. Décisions restant à prendre

- Comportement en cas de conflit, par exemple si un fichier est modifié des deux côtés avant synchronisation.
- Politique de suppression : suppression immédiate du miroir ou conservation temporaire d’une copie.
- Étendue exacte des albums : dossiers MEGA ou collections virtuelles propres à l’application.

## 7. Critères de réussite

- La galerie permet de parcourir les dossiers, photos et vidéos de MEGA sur ordinateur et mobile.
- Les fonctionnalités de recherche, favoris, albums, diaporama et lecture vidéo sont disponibles.
- Les opérations de gestion effectuées dans l’application sont répercutées sur MEGA et dans le miroir, sous réserve des capacités de l’API.
- Si MEGA est indisponible, les médias présents sur le serveur restent consultables.
- Aucune base de données n’est nécessaire au fonctionnement initial.
