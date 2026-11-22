# Charakter-Auktion

Lokales Party-Spiel: Der Fernseher zeigt das Spielfeld, alle bieten per Handy (QR-Code, kein Login).

## Starten

Voraussetzung: Node.js 18+

```bash
npm install
npm start
```

Die Konsole zeigt drei Links:

| Wofür | Link |
|---|---|
| TV / Gamemaster am selben Rechner | `http://localhost:3000/host` |
| TV auf anderem Gerät | `http://<LAN-IP>:3000/host?key=<code>` |
| Spieler (steckt im QR-Code) | `http://<LAN-IP>:3000/play` |

Handys und Rechner müssen im selben WLAN sein – außer der Internet-Zugang ist an (siehe unten). Falls die erkannte IP falsch ist (VPN, Docker …):
`PUBLIC_HOST=192.168.1.50 npm start`. Port ändern: `PORT=8080 npm start`. Fester Gamemaster-Code: `HOST_KEY=geheim npm start`.

## Von außerhalb des WLANs mitspielen (ngrok)

Einmalig einen kostenlosen Account auf [ngrok.com](https://ngrok.com) anlegen und den Authtoken hinterlegen, entweder:

```bash
ngrok config add-authtoken <token>     # falls die ngrok-CLI installiert ist (wird automatisch gelesen)
# oder
export NGROK_AUTHTOKEN=<token>
```

Dann in der Lobby auf **Internet-Zugang (ngrok) einschalten** klicken, oder direkt mit Tunnel starten: `npm run online`.
Der QR-Code zeigt danach die öffentliche `https://…ngrok…`-Adresse, die von überall funktioniert. Eine feste Domain aus dem ngrok-Dashboard geht mit `NGROK_DOMAIN=meinname.ngrok-free.app`.

- Beim kostenlosen ngrok-Plan sehen Spieler beim ersten Öffnen eine ngrok-Hinweisseite, einfach auf **Visit Site** tippen.
- Über den Tunnel bekommt niemand Gamemaster-Rechte. `/host` von außen geht nur mit `?key=…` aus der Konsole.

## Hintergrundmusik

Eigene Musik in den Ordner `music/` legen (mp3, ogg, m4a, wav, flac, webm, opus) und **Ordner neu einlesen** klicken. Dann in der Lobby, in der Gamemaster-Leiste oder in den Einstellungen einen Titel und die Lautstärke wählen. Die Musik läuft nur am TV.
Neben der Auswahl gibt es **⏸ Stopp / ▶ Abspielen** (Lobby, Gamemaster-Leiste und Einstellungsfenster). Browser spielen Ton oft erst nach einem Klick auf die Seite ab: Dann erscheint am TV **♪ Musik starten**, und jeder Klick auf den TV startet die Musik. Das Einstellungsfenster zeigt an, ob die Musik am TV wirklich läuft, blockiert ist oder das Dateiformat nicht abgespielt werden kann (mp3 geht überall).

## Gamemaster-Einstellungen (Popup-Fenster)

**⚙ Einstellungen** am TV öffnet ein eigenes Fenster (`/admin`, von einem anderen Gerät `/admin?key=<code>`). Dort kann der Gamemaster das ganze Spiel verändern:

| Tab | Was geht |
|---|---|
| Spiel | Aktueller Charakter **mit Namen, auch wenn er noch verdeckt ist**, Status aller Spieler, verschenken, **Kategorie-Plan** umstellen, Verlauf |
| Stapel | Die nächsten Charakter sehen und umsortieren (ziehen oder ⤒ ↑ ↓), herausnehmen, mischen, beliebige Charakter oben/unten einfügen, Übersprungene zurückholen |
| Spieler | Geld setzen (`750M`, `1,2Mrd`) oder ±10/50/100 Mio, Joker-Einsätze mit − / + ändern, umbenennen |
| Raster | Feld anklicken: Charakter entfernen (mit/ohne Geld zurück), beliebigen Charakter mit Preis setzen oder mit einem beliebigen anderen Feld **tauschen, ohne dass die Spieler zustimmen müssen** (auch über Runden hinweg) |
| Glücksräder | Räder anlegen, bearbeiten, speichern und jederzeit **anzeigen und drehen** (auch in der Lobby) |
| Einstellungen | Rundengeld (Min/Max in Mio), Musik, Hintergrundfarbe, Spieler/Runden (nur Lobby), ngrok, Neustart |

Oben im Fenster sind immer die wichtigsten Knöpfe (Aufdecken, Zuschlag, Skippen, Gebote zurücksetzen, Weiter).

## Eigene Glücksräder

Die Räder stehen in `wheels/wheels.json`. Bearbeiten geht direkt in der Datei oder im Einstellungsfenster (das schreibt die Datei):

```json
{
  "wheels": [
    { "name": "Wer ist dran?", "segments": "players" },
    {
      "name": "Bonusrad",
      "segments": ["+50 Mio", "Nichts", "+100 Mio", "Joker zurück"],
      "durationMs": 6000,
      "sound": "spin.mp3",
      "endSound": "tada.mp3"
    }
  ]
}
```

- `segments`: Liste der Felder (2–30) oder `"players"` für die aktuellen Spielernamen
- `durationMs`: Drehdauer (1000–30000, Standard 5000)
- `sound` (optional): läuft am TV, während das Rad dreht. `endSound` (optional) beim Ergebnis. Die Sound-Dateien kommen in den Ordner `wheels/`.
- **Anzeigen** zeigt das Rad am TV über allem, und die Handys zeigen seine Felder. Gedreht wird erst, wenn der Gamemaster auf **Drehen** klickt (im Einstellungsfenster, am TV-Knopf oder direkt aufs Rad). Danach steht das Ergebnis überall, und **Nochmal drehen** oder **Schließen** geht.
- Die Handys zeigen das Ergebnis an. Geld oder Joker setzt der Gamemaster danach selbst in den Einstellungen.

## Charakter hinzufügen

Bilder in `characters/` legen. **Unterordner = Kategorie, Dateiname = Name + Startwert:**

```
characters/
  Krieger/
    Eisenfaust_300M.png        → Eisenfaust, Krieger, 300 Mio
    Schatten_Klinge_1.2Mrd.jpg → Schatten Klinge, Krieger, 1,2 Mrd
  Magier/
    Frostrune_275M.webp
```

- Wert-Endungen: `k`, `M`/`Mio`, `B`/`Mrd`, oder eine nackte Zahl (`250000000`)
- `_` im Namen wird zu Leerzeichen
- Optional eine JSON-Datei mit gleichem Namen daneben, die Werte überschreibt:
  `Eisenfaust_300M.json` → `{ "name": "Eisenfaust der Große", "value": "350M", "category": "Boss" }`
- Formate: png, jpg, webp, gif, svg, avif
- Nach dem Hinzufügen in der Lobby auf **Ordner neu einlesen** klicken (beim Spielstart passiert das automatisch)

Die mitgelieferten Bilder sind nur Platzhalter. Einfach löschen und durch eigene ersetzen.

## Ablauf

1. **Lobby (TV):** Der Gamemaster stellt Spieleranzahl (2–8), Runden (5–10), Rundengeld, Hintergrund und Musik ein. Die Spieler scannen den QR-Code und geben ihren Namen ein, optional mit Profilbild aus der Galerie oder direkt von der Kamera.
2. **Start:** Der Gamemaster bestätigt. Das Raster hat eine Zeile pro Spieler und eine Spalte pro Runde. Alle starten mit **1 Mrd**.
3. **Kategorien:** Jede Runde hat eine feste Kategorie aus dem **Kategorie-Plan**. Er ist automatisch vorbelegt (alle Kategorien der Reihe nach, bei mehr Runden wieder von vorne) und steht in der Lobby am TV. Der Gamemaster kann ihn vor und während des Spiels in **⚙ Einstellungen → Spiel** umstellen: Kategorie pro Runde wählen (auch **Gemischt**), Runden mit ↑ ↓ tauschen, automatisch neu verteilen oder mischen. Gespielte Runden sind fest. Ändert sich die laufende Runde, wird ihr Stapel neu gemischt. Zum Rundenstart blendet der TV die Kategorie groß ein. In der Runde kommen nur Charakter dieser Kategorie, schon ersteigerte bleiben draußen, solange die Kategorie genug hergibt.
4. **Vorbereitung (vor jeder Runde, auch der ersten):** Der Stapel der Runde wird aus ihrer Kategorie gemischt. Der TV zeigt „Runde X · Kategorie“, und das Einstellungsfenster springt automatisch auf **Stapel**. Dort legt der Gamemaster die Reihenfolge fest (ziehen oder ⤒ ↑ ↓, herausnehmen, andere Charakter einfügen). Mit **Runde starten** (Einstellungsfenster oder Gamemaster-Leiste am TV) beginnt die Auktion mit dem obersten Charakter.
5. **Auktion:** Ein Charakter nach dem anderen wird versteigert.
   - Jeder Charakter kommt **verdeckt**: Zu sehen sind nur Startwert und Kategorie. Schon jetzt darf vorab geboten werden.
   - Der Gamemaster drückt **Charakter aufdecken**, dann sieht man Name und Bild. **Aussteigen** geht schon vorher. Steigen alle aus, ohne dass jemand geboten hat, kommt sofort der nächste Charakter. Der **Zuschlag** passiert erst nach dem Aufdecken.
   - Das erste Gebot muss mindestens dem Startwert entsprechen, jedes weitere muss höher sein. Niemand kann mehr bieten, als er hat.
   - **Aussteigen** gilt für den aktuellen Charakter. Bleibt nur noch der Höchstbietende übrig, bekommt er den Charakter automatisch (oder der Gamemaster drückt **Zuschlag**).
   - **Skippen** geht jederzeit, auch solange der Charakter noch verdeckt ist. Bei Mehrheit kommt er zurück auf den Stapel.
   - Wer in der aktuellen Runde schon einen Charakter hat, bietet in dieser Runde nicht mehr mit.
   - Ist der Stapel leer, kommen die übersprungenen Charakter wieder dran. Sind alle vergeben, wird der ganze Pool neu gemischt.
6. **Rundenende:** Sobald jeder Spieler einen Charakter in der Runde hat, bekommt jeder zufällig einen Betrag zwischen Minimum und Maximum (ganze Mio, in der Lobby einstellbar; Min = Max ⇒ fester Betrag). Nach der letzten Runde gibt es kein Rundengeld mehr – das Spiel ist direkt vorbei. Der TV zählt die Beträge mit einer kurzen Animation hoch, dann geht's mit **Weiter mit Runde …** weiter.
7. **Ende:** Wenn das Raster voll ist, ist das Spiel vorbei. Wer gewonnen hat, diskutiert ihr selbst aus.

### Joker

Wie oft jeder Spieler jeden Joker einsetzen darf, stellt der Gamemaster in der Lobby ein (**Joker pro Spieler**, 0–9, 0 schaltet einen Joker ab). Im Spiel kann er die Anzahl pro Spieler unter ⚙ Einstellungen → Spieler mit − / + anpassen. Am TV stehen die Joker als Symbol-Plättchen neben jedem Spieler (Zahl = übrige Einsätze, grau und durchgestrichen = aufgebraucht), am Handy als Text.

| Joker | Wirkung |
|---|---|
| Weißes Monster | +100 Mio Guthaben, nur solange der aktuelle Charakter noch verdeckt ist (Vorab-Joker) |
| Sperre | Ein Spieler darf beim aktuellen Charakter nicht mitbieten – nur bis zum ersten Gebot auf den Charakter (vorher, auch verdeckt, geht's) |
| Tausch | Du **bietest** einem anderen Spieler einen Tausch in einer Runde an (beide brauchen dort einen Charakter). Er bekommt das Angebot aufs Handy und kann **annehmen oder ablehnen**, du kannst es zurückziehen. Der Joker ist erst weg, wenn der Tausch angenommen wird. Pro Spieler ist ein offenes Angebot möglich. Geht auch noch **nach dem Spiel** (die anderen Joker nicht). |
| Spicken | Du wählst eine **Position im Stapel dieser Runde** (Nr. 1 = der gerade verdeckte Charakter bzw. der nächste) und siehst heimlich, welcher Charakter dort liegt. Nur dein Handy zeigt das Ergebnis, im Verlauf steht nur „X spickt auf Position N“. Die Reihenfolge kann sich danach noch ändern (Skippen, Gamemaster). |

### Gamemaster-Knöpfe im Spiel

**Runde starten** · **Charakter aufdecken** · **Zuschlag** · **Charakter skippen** · **⚙ Einstellungen** · **Verschenken an …** (gratis zuweisen, falls jemand pleite ist und die Runde sonst hängt) · **Neu starten** · **Zur Lobby**

## Technik

- `server.js`: Express + Socket.IO, die gesamte Spiellogik läuft auf dem Server (Clients können nicht schummeln)
- `public/host.*`: TV-Ansicht, `public/play.*`: Handy-Ansicht, `public/admin.*`: Gamemaster-Einstellungsfenster, `public/music.js`: Musik und Rad-Sounds
- Der Spielstand liegt nur im Speicher. Ein Server-Neustart setzt das Spiel zurück. Handys verbinden sich nach einem Neuladen der Seite automatisch wieder (Token im localStorage).
- Nach einem Update einfach den Server neu starten: Offene TV-, Handy- und Einstellungsseiten merken das und laden sich selbst neu. Handys kommen dabei automatisch wieder ins Spiel.
- Test: `npm test` spielt ein komplettes Spiel automatisch durch
