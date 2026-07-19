# XRechnung & ZUGFeRD Viewer

Kostenloser, **100 % clientseitiger** Viewer für elektronische Rechnungen: XRechnung (UBL & CII) und ZUGFeRD im Browser anzeigen und auf Pflichtfelder (EN 16931) prüfen.

**Kein Upload.** Die Verarbeitung läuft vollständig als JavaScript im Browser – Ihre Rechnungsdaten verlassen Ihren Computer nicht.

## Funktionen
- XRechnung-XML (UBL `Invoice`/`CreditNote` und UN/CEFACT CII) lesbar darstellen
- ZUGFeRD-PDF: eingebettetes XML extrahieren und anzeigen
- Plausibilitätsprüfung der zentralen Pflichtfelder + Summenkontrolle (Netto + USt = Brutto)
- Druck-/PDF-Export der lesbaren Ansicht

## Nutzung
Öffnen Sie die Seite und ziehen Sie Ihre `.xml`- oder `.pdf`-Datei in das Feld. Fertig.

## Technik
Statische Seite ohne Build-Schritt und ohne externe Abhängigkeiten (reines HTML/CSS/JS). Deployt via GitHub Actions auf GitHub Pages.

## Hinweis
Allgemeines Werkzeug, keine Steuer- oder Rechtsberatung. Alle Angaben ohne Gewähr.
