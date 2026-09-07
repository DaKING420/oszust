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


## Dobieranie 3 kart
Jeśli gracz nie chce zagrać karty niższej od aktualnej rangi i nie chce blefować, w swojej turze może użyć „DOBIERZ 3”. Po dobraniu 3 kart następna karta z góry stosu dobierania jest odkrywana jako widoczny wyznacznik rangi. Dobranie nie kończy tury gracza.
