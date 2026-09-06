# OSZUST — multiplayer

Gra karciana multiplayer działająca w przeglądarce przez WebSocket.

## Uruchomienie

```bash
npm install
npm start
```

Serwer używa `PORT` z Rendera lub domyślnie portu 3000.

## Render

- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: `oszust` (jeśli repozytorium ma projekt w folderze `oszust`)

## Diagnostyka

Po wdrożeniu otwórz `/health`, np. `https://twoja-aplikacja.onrender.com/health`.
Powinien pojawić się JSON ze statusem serwera oraz liczbą pokoi i graczy.
