/* XRechnung / ZUGFeRD Viewer — 100% clientseitig, keine Abhängigkeiten.
   Unterstützt UBL (Invoice/CreditNote) und UN/CEFACT CII (CrossIndustryInvoice).
   Parsing ist namespace-agnostisch (nur localName), um Präfix-Varianten zu tolerieren. */
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var dropzone = $("#dropzone"),
      fileInput = $("#fileInput"),
      errorBox = $("#error"),
      resultEl = $("#result"),
      checksEl = $("#checks"),
      invoiceEl = $("#invoice");
  var batchEl = $("#batch"),
      batchBodyEl = $("#batchBody"),
      batchCountEl = $("#batchCount");
  var currentInvoice = null;
  var currentBatch = [];

  /* ---------- XML-Helfer (namespace-agnostisch) ---------- */
  function kids(node, name) {
    var out = [];
    if (!node) return out;
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].localName === name) out.push(node.children[i]);
    }
    return out;
  }
  function child(node, name) { return kids(node, name)[0] || null; }
  // Pfad wie "cac:Party/cbc:PartyName" -> hier ["Party","PartyName"] (localNames)
  function pick(node, path) {
    var cur = node;
    for (var i = 0; i < path.length && cur; i++) cur = child(cur, path[i]);
    return cur;
  }
  function text(node, path) {
    var el = path ? pick(node, path) : node;
    return el ? (el.textContent || "").trim() : "";
  }
  function attr(node, name) { return node && node.getAttribute ? (node.getAttribute(name) || "") : ""; }
  // erste Tiefen-Übereinstimmung eines localName irgendwo unterhalb node
  function deep(node, name) {
    if (!node) return null;
    var stack = [node];
    while (stack.length) {
      var n = stack.shift();
      for (var i = 0; i < n.children.length; i++) {
        if (n.children[i].localName === name) return n.children[i];
        stack.push(n.children[i]);
      }
    }
    return null;
  }

  /* ---------- Formatierung ---------- */
  function num(v) {
    if (v === "" || v == null) return null;
    var n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
    return isNaN(n) ? null : n;
  }
  function fmtMoney(v, cur) {
    var n = num(v);
    if (n == null) return "—";
    try {
      return new Intl.NumberFormat("de-DE", { style: "currency", currency: cur || "EUR" }).format(n);
    } catch (e) {
      return n.toFixed(2) + " " + (cur || "");
    }
  }
  function fmtQty(v) {
    var n = num(v); if (n == null) return "—";
    return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 4 }).format(n);
  }
  function fmtDate(s) {
    if (!s) return "—";
    var m = String(s).trim();
    // UBL: 2024-05-01 ; CII udt:DateTimeString format="102": 20240501
    if (/^\d{8}$/.test(m)) m = m.slice(0, 4) + "-" + m.slice(4, 6) + "-" + m.slice(6, 8);
    var d = new Date(m);
    if (isNaN(d.getTime())) return m;
    return d.toLocaleDateString("de-DE", { year: "numeric", month: "long", day: "numeric" });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var TYPE_CODES = {
    "380": "Rechnung", "381": "Gutschrift", "384": "Rechnungskorrektur",
    "389": "Selbst ausgestellte Rechnung", "326": "Teilrechnung", "875": "Teilschlussrechnung"
  };

  /* ---------- UBL-Parser ---------- */
  function parseUBL(root) {
    var isCredit = root.localName === "CreditNote";
    var lineTag = isCredit ? "CreditNoteLine" : "InvoiceLine";
    var qtyTag = isCredit ? "CreditedQuantity" : "InvoicedQuantity";

    function party(container) {
      var p = pick(root, [container, "Party"]);
      if (!p) return null;
      var name = text(p, ["PartyLegalEntity", "RegistrationName"]) || text(p, ["PartyName", "Name"]);
      var pa = child(p, "PostalAddress");
      var addr = pa ? {
        street: [text(pa, ["StreetName"]), text(pa, ["AdditionalStreetName"])].filter(Boolean).join(", "),
        city: text(pa, ["CityName"]),
        zip: text(pa, ["PostalZone"]),
        country: text(pa, ["Country", "IdentificationCode"])
      } : null;
      var vat = "";
      kids(p, "PartyTaxScheme").forEach(function (ts) {
        var scheme = text(ts, ["TaxScheme", "ID"]);
        var id = text(ts, ["CompanyID"]);
        if (id && (scheme === "VAT" || !vat)) vat = id;
      });
      return { name: name, addr: addr, vat: vat };
    }

    var lines = kids(root, lineTag).map(function (l) {
      var item = child(l, "Item");
      return {
        id: text(l, ["ID"]),
        name: item ? text(item, ["Name"]) : "",
        desc: item ? text(item, ["Description"]) : "",
        qty: text(l, [qtyTag]),
        unit: attr(child(l, qtyTag), "unitCode"),
        price: text(l, ["Price", "PriceAmount"]),
        net: text(l, ["LineExtensionAmount"]),
        taxpct: item ? text(item, ["ClassifiedTaxCategory", "Percent"]) : ""
      };
    });

    var lmt = child(root, "LegalMonetaryTotal") || {};
    var taxTotals = kids(root, "TaxTotal");
    var taxAmount = taxTotals.length ? text(taxTotals[0], ["TaxAmount"]) : "";
    var taxRows = [];
    taxTotals.forEach(function (tt) {
      kids(tt, "TaxSubtotal").forEach(function (st) {
        taxRows.push({
          base: text(st, ["TaxableAmount"]),
          amount: text(st, ["TaxAmount"]),
          pct: text(st, ["TaxCategory", "Percent"]),
          cat: text(st, ["TaxCategory", "ID"])
        });
      });
    });

    var pm = child(root, "PaymentMeans");
    var iban = pm ? text(pm, ["PayeeFinancialAccount", "ID"]) : "";
    var bic = pm ? text(pm, ["PayeeFinancialAccount", "FinancialInstitutionBranch", "ID"]) : "";

    return {
      syntax: "UBL", docType: isCredit ? "CreditNote" : "Invoice",
      id: text(root, ["ID"]),
      typeCode: text(root, [isCredit ? "CreditNoteTypeCode" : "InvoiceTypeCode"]),
      issueDate: text(root, ["IssueDate"]),
      dueDate: text(root, ["DueDate"]),
      currency: text(root, ["DocumentCurrencyCode"]) || "EUR",
      buyerRef: text(root, ["BuyerReference"]),
      note: text(root, ["Note"]),
      seller: party("AccountingSupplierParty"),
      buyer: party("AccountingCustomerParty"),
      lines: lines,
      totals: {
        net: text(lmt, ["LineExtensionAmount"]),
        taxExcl: text(lmt, ["TaxExclusiveAmount"]),
        taxIncl: text(lmt, ["TaxInclusiveAmount"]),
        allowance: text(lmt, ["AllowanceTotalAmount"]),
        charge: text(lmt, ["ChargeTotalAmount"]),
        prepaid: text(lmt, ["PrepaidAmount"]),
        payable: text(lmt, ["PayableAmount"]),
        tax: taxAmount
      },
      taxRows: taxRows,
      iban: iban, bic: bic
    };
  }

  /* ---------- CII-Parser (CrossIndustryInvoice) ---------- */
  function parseCII(root) {
    var doc = deep(root, "ExchangedDocument");
    var tx = child(root, "SupplyChainTradeTransaction");
    var agree = tx ? child(tx, "ApplicableHeaderTradeAgreement") : null;
    var deliv = tx ? child(tx, "ApplicableHeaderTradeDelivery") : null;
    var settle = tx ? child(tx, "ApplicableHeaderTradeSettlement") : null;

    function party(el) {
      if (!el) return null;
      var name = text(el, ["Name"]);
      var pa = child(el, "PostalTradeAddress");
      var addr = pa ? {
        street: [text(pa, ["LineOne"]), text(pa, ["LineTwo"])].filter(Boolean).join(", "),
        city: text(pa, ["CityName"]),
        zip: text(pa, ["PostcodeCode"]),
        country: text(pa, ["CountryID"])
      } : null;
      var vat = "";
      kids(el, "SpecifiedTaxRegistration").forEach(function (r) {
        var id = child(r, "ID");
        if (id && (attr(id, "schemeID") === "VA" || !vat)) vat = (id.textContent || "").trim();
      });
      return { name: name, addr: addr, vat: vat };
    }

    var lines = (tx ? kids(tx, "IncludedSupplyChainTradeLineItem") : []).map(function (l) {
      var prod = child(l, "SpecifiedTradeProduct");
      var la = child(l, "SpecifiedLineTradeAgreement");
      var ld = child(l, "SpecifiedLineTradeDelivery");
      var ls = child(l, "SpecifiedLineTradeSettlement");
      var price = la ? (text(la, ["NetPriceProductTradePrice", "ChargeAmount"]) ||
                        text(la, ["GrossPriceProductTradePrice", "ChargeAmount"])) : "";
      var qtyEl = ld ? child(ld, "BilledQuantity") : null;
      var tax = ls ? child(ls, "ApplicableTradeTax") : null;
      var mon = ls ? child(ls, "SpecifiedTradeSettlementLineMonetarySummation") : null;
      return {
        id: text(l, ["AssociatedDocumentLineDocument", "LineID"]),
        name: prod ? text(prod, ["Name"]) : "",
        desc: prod ? text(prod, ["Description"]) : "",
        qty: qtyEl ? (qtyEl.textContent || "").trim() : "",
        unit: attr(qtyEl, "unitCode"),
        price: price,
        net: mon ? text(mon, ["LineTotalAmount"]) : "",
        taxpct: tax ? text(tax, ["RateApplicablePercent"]) : ""
      };
    });

    var mon = settle ? child(settle, "SpecifiedTradeSettlementHeaderMonetarySummation") : null;
    var taxRows = settle ? kids(settle, "ApplicableTradeTax").map(function (t) {
      return {
        base: text(t, ["BasisAmount"]),
        amount: text(t, ["CalculatedAmount"]),
        pct: text(t, ["RateApplicablePercent"]),
        cat: text(t, ["CategoryCode"])
      };
    }) : [];

    var terms = settle ? child(settle, "SpecifiedTradePaymentTerms") : null;
    var pmeans = settle ? child(settle, "SpecifiedTradeSettlementPaymentMeans") : null;
    var iban = pmeans ? text(pmeans, ["PayeePartyCreditorFinancialAccount", "IBANID"]) : "";
    var bic = pmeans ? text(pmeans, ["PayeeSpecifiedCreditorFinancialInstitution", "BICID"]) : "";

    return {
      syntax: "CII", docType: "Invoice",
      id: doc ? text(doc, ["ID"]) : "",
      typeCode: doc ? text(doc, ["TypeCode"]) : "",
      issueDate: doc ? text(doc, ["IssueDateTime", "DateTimeString"]) : "",
      dueDate: terms ? text(terms, ["DueDateDateTime", "DateTimeString"]) : "",
      currency: (settle ? text(settle, ["InvoiceCurrencyCode"]) : "") || "EUR",
      buyerRef: agree ? text(agree, ["BuyerReference"]) : "",
      note: doc ? text(doc, ["IncludedNote", "Content"]) : "",
      seller: party(agree ? child(agree, "SellerTradeParty") : null),
      buyer: party(agree ? child(agree, "BuyerTradeParty") : null),
      lines: lines,
      totals: mon ? {
        net: text(mon, ["LineTotalAmount"]),
        taxExcl: text(mon, ["TaxBasisTotalAmount"]),
        taxIncl: text(mon, ["GrandTotalAmount"]),
        allowance: text(mon, ["AllowanceTotalAmount"]),
        charge: text(mon, ["ChargeTotalAmount"]),
        prepaid: text(mon, ["TotalPrepaidAmount"]),
        payable: text(mon, ["DuePayableAmount"]),
        tax: text(mon, ["TaxTotalAmount"])
      } : {},
      taxRows: taxRows,
      iban: iban, bic: bic
    };
  }

  /* ---------- Validierung (Plausibilität, kein Schematron) ---------- */
  function validate(inv) {
    var c = [];
    function add(ok, title, detail) { c.push({ level: ok === true ? "ok" : ok === false ? "bad" : "warn", title: title, detail: detail }); }

    add(!!inv.id, "Rechnungsnummer (BT-1)", inv.id ? inv.id : "Fehlt – Pflichtangabe.");
    add(!!inv.issueDate, "Rechnungsdatum (BT-2)", inv.issueDate ? fmtDate(inv.issueDate) : "Fehlt – Pflichtangabe.");
    add(inv.seller && !!inv.seller.name, "Verkäufer-Name (BT-27)", inv.seller && inv.seller.name ? inv.seller.name : "Fehlt.");
    add(inv.buyer && !!inv.buyer.name, "Käufer-Name (BT-44)", inv.buyer && inv.buyer.name ? inv.buyer.name : "Fehlt.");
    add(!!inv.currency, "Währung (BT-5)", inv.currency || "Fehlt.");
    add(inv.lines.length > 0, "Rechnungspositionen", inv.lines.length + " Position(en).");

    // Steuer-ID des Verkäufers
    var hasSellerTax = inv.seller && inv.seller.vat;
    add(hasSellerTax ? true : "warn", "USt-IdNr./Steuernummer Verkäufer",
      hasSellerTax ? inv.seller.vat : "Nicht gefunden – bei Kleinunternehmern (§19 UStG) zulässig, sonst prüfen.");

    // Leitweg-ID nur relevant für öffentliche Auftraggeber
    if (inv.buyerRef) add(true, "Leitweg-ID / Käuferreferenz (BT-10)", inv.buyerRef);

    // Rechnerische Stimmigkeit: taxIncl ~= taxExcl + tax
    var te = num(inv.totals.taxExcl), tx = num(inv.totals.tax), ti = num(inv.totals.taxIncl);
    if (te != null && tx != null && ti != null) {
      var ok = Math.abs((te + tx) - ti) < 0.02;
      add(ok, "Summenprüfung (Netto + USt = Brutto)",
        fmtMoney(te, inv.currency) + " + " + fmtMoney(tx, inv.currency) + " = " +
        fmtMoney(te + tx, inv.currency) + (ok ? " ✓ stimmt mit Brutto überein." : " ✗ weicht vom Bruttobetrag " + fmtMoney(ti, inv.currency) + " ab."));
    }
    // Zahlbetrag vorhanden
    add(num(inv.totals.payable) != null ? true : "warn", "Zahlbetrag (BT-115)",
      num(inv.totals.payable) != null ? fmtMoney(inv.totals.payable, inv.currency) : "Nicht gefunden.");

    return c;
  }

  /* ---------- Rendering ---------- */
  function renderChecks(checks) {
    checksEl.innerHTML = checks.map(function (c) {
      var ico = c.level === "ok" ? "✔" : c.level === "bad" ? "✕" : "!";
      return '<li class="' + c.level + '"><span class="ico">' + ico + '</span>' +
        '<span class="txt"><strong>' + esc(c.title) + '</strong><span>' + esc(c.detail) + '</span></span></li>';
    }).join("");
  }

  function partyHTML(p, label) {
    if (!p) return '<div class="party"><h4>' + label + '</h4><p class="muted">—</p></div>';
    var a = p.addr || {};
    var lines = [];
    if (a.street) lines.push(esc(a.street));
    var cityLine = [a.zip, a.city].filter(Boolean).join(" ");
    if (cityLine) lines.push(esc(cityLine));
    if (a.country) lines.push(esc(a.country));
    return '<div class="party"><h4>' + label + '</h4>' +
      '<div class="pname">' + esc(p.name || "—") + '</div>' +
      '<address>' + lines.join("<br>") + '</address>' +
      (p.vat ? '<div class="taxid">USt-IdNr./Steuernr.: ' + esc(p.vat) + '</div>' : '') +
      '</div>';
  }

  function renderInvoice(inv) {
    var t = inv.totals, cur = inv.currency;
    var typeLabel = TYPE_CODES[inv.typeCode] || (inv.docType === "CreditNote" ? "Gutschrift" : "Rechnung");

    var linesHTML = inv.lines.map(function (l, i) {
      return '<tr><td class="num pos" data-label="Pos.">' + esc(l.id || (i + 1)) + '</td>' +
        '<td class="desc" data-label="Bezeichnung">' + esc(l.name || "—") + (l.desc ? '<br><span class="muted small">' + esc(l.desc) + '</span>' : '') + '</td>' +
        '<td class="num" data-label="Menge">' + fmtQty(l.qty) + (l.unit ? ' <span class="muted">' + esc(l.unit) + '</span>' : '') + '</td>' +
        '<td class="num" data-label="Einzelpreis">' + (num(l.price) != null ? fmtMoney(l.price, cur) : "—") + '</td>' +
        '<td class="num" data-label="USt">' + (l.taxpct ? esc(l.taxpct) + " %" : "—") + '</td>' +
        '<td class="num" data-label="Netto">' + (num(l.net) != null ? fmtMoney(l.net, cur) : "—") + '</td></tr>';
    }).join("");

    var taxHTML = inv.taxRows.filter(function (r) { return num(r.base) != null || num(r.amount) != null; }).map(function (r) {
      return (r.pct ? r.pct + " % " : "") + "auf " + fmtMoney(r.base, cur) + " = " + fmtMoney(r.amount, cur);
    }).join(" · ");

    function totalRow(label, val, cls) {
      if (num(val) == null) return "";
      return '<div class="row ' + (cls || "") + '"><span>' + label + '</span><span>' + fmtMoney(val, cur) + '</span></div>';
    }

    invoiceEl.innerHTML =
      '<div class="inv-head">' +
        '<div class="inv-title"><h3>' + esc(typeLabel) + '</h3>' +
          '<span class="badge">' + esc(inv.syntax) + '</span>' +
          (inv.typeCode ? '<span class="badge">Typ ' + esc(inv.typeCode) + '</span>' : '') + '</div>' +
        '<div class="inv-meta">' +
          '<div><b>Nr.:</b> ' + esc(inv.id || "—") + '</div>' +
          '<div><b>Datum:</b> ' + fmtDate(inv.issueDate) + '</div>' +
          (inv.dueDate ? '<div><b>Fällig:</b> ' + fmtDate(inv.dueDate) + '</div>' : '') +
          (inv.buyerRef ? '<div><b>Leitweg-ID:</b> ' + esc(inv.buyerRef) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="parties">' + partyHTML(inv.seller, "Verkäufer") + partyHTML(inv.buyer, "Käufer") + '</div>' +
      (inv.note ? '<p class="muted small">' + esc(inv.note) + '</p>' : '') +
      '<table class="lines"><thead><tr>' +
        '<th class="num">Pos.</th><th>Bezeichnung</th><th class="num">Menge</th>' +
        '<th class="num">Einzelpreis</th><th class="num">USt</th><th class="num">Netto</th>' +
      '</tr></thead><tbody>' + (linesHTML || '<tr><td colspan="6" class="muted">Keine Positionen gefunden.</td></tr>') + '</tbody></table>' +
      '<div class="totals">' +
        totalRow("Zwischensumme netto", t.net || t.taxExcl) +
        totalRow("Rabatte", t.allowance) +
        totalRow("Zuschläge", t.charge) +
        totalRow("Netto gesamt", t.taxExcl) +
        totalRow("Umsatzsteuer", t.tax) +
        (taxHTML ? '<div class="taxrows">' + esc(taxHTML).replace(/·/g, "·") + '</div>' : "") +
        totalRow("Bruttobetrag", t.taxIncl) +
        totalRow("Bereits gezahlt", t.prepaid) +
        totalRow("Zahlbetrag", t.payable, "grand") +
      '</div>' +
      (inv.iban ? '<div class="payinfo"><div class="kv"><b>IBAN</b> ' + esc(inv.iban) + '</div>' +
        (inv.bic ? '<div class="kv"><b>BIC</b> ' + esc(inv.bic) + '</div>' : '') + '</div>' : '');
  }

  /* ---------- Datei-Handling ---------- */
  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
    resultEl.classList.add("hidden");
  }
  function clearError() { errorBox.classList.add("hidden"); }

  // Parsen ohne Rendern -> liefert inv oder { error }
  function xmlToInvoice(xmlStr) {
    var dom = new DOMParser().parseFromString(xmlStr, "application/xml");
    if (dom.querySelector("parsererror")) return { error: "Keine gültige XML-Datei." };
    var root = dom.documentElement, ln = root.localName;
    if (ln === "Invoice" || ln === "CreditNote") return parseUBL(root);
    if (ln === "CrossIndustryInvoice") return parseCII(root);
    if (deep(root, "CrossIndustryInvoice")) return parseCII(deep(root, "CrossIndustryInvoice"));
    return { error: "Unbekanntes Format (kein XRechnung/ZUGFeRD). Wurzel: <" + ln + ">" };
  }

  function showSingle(inv) {
    clearError();
    batchEl.classList.add("hidden");
    currentInvoice = inv;
    renderChecks(validate(inv));
    renderInvoice(inv);
    resultEl.classList.remove("hidden");
    resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function processXMLString(xmlStr) {
    var inv = xmlToInvoice(xmlStr);
    if (inv.error) { showError(inv.error); return; }
    showSingle(inv);
  }

  // ZUGFeRD: eingebettete XML aus PDF extrahieren (best effort, ohne externe Libs)
  async function extractXMLfromPDF(bytes) {
    var latin1 = "";
    for (var i = 0; i < bytes.length; i++) latin1 += String.fromCharCode(bytes[i]);

    // 1) unkomprimierte XML-Streams direkt suchen
    var direct = latin1.match(/<\?xml[\s\S]*?(<(?:rsm:)?CrossIndustryInvoice[\s\S]*?<\/(?:rsm:)?CrossIndustryInvoice>|<(?:ubl:)?Invoice[\s\S]*?<\/(?:ubl:)?Invoice>)/i);
    if (direct) return direct[0];

    // 2) FlateDecode-Streams dekomprimieren und nach XML durchsuchen
    if (typeof DecompressionStream === "function") {
      var re = /stream\r?\n/g, m;
      while ((m = re.exec(latin1)) !== null) {
        var start = m.index + m[0].length;
        var end = latin1.indexOf("endstream", start);
        if (end < 0) continue;
        var chunk = latin1.slice(start, end);
        var buf = new Uint8Array(chunk.length);
        for (var j = 0; j < chunk.length; j++) buf[j] = chunk.charCodeAt(j) & 0xff;
        try {
          var ds = new DecompressionStream("deflate");
          var stream = new Response(new Blob([buf]).stream().pipeThrough(ds));
          var outArr = new Uint8Array(await stream.arrayBuffer());
          var out = "";
          for (var k = 0; k < outArr.length; k++) out += String.fromCharCode(outArr[k]);
          var mm = out.match(/<\?xml[\s\S]*?(CrossIndustryInvoice|<(?:ubl:)?Invoice)[\s\S]*/i);
          if (mm && /(CrossIndustryInvoice|<(?:ubl:)?Invoice)/.test(out)) {
            var full = out.match(/<\?xml[\s\S]*<\/[^>]*(CrossIndustryInvoice|Invoice)>/i);
            if (full) return full[0];
          }
        } catch (e) { /* nächster Stream */ }
      }
    }
    return null;
  }

  // Datei -> XML-String (oder null bei PDF ohne eingebettete E-Rechnung)
  async function fileToXml(file) {
    var name = (file.name || "").toLowerCase();
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      var pdfBytes = new Uint8Array(await file.arrayBuffer());
      return await extractXMLfromPDF(pdfBytes);
    }
    return await file.text();
  }

  // Mehrere Dateien: 1 = Detailansicht, >1 = Sammel-Tabelle (Batch)
  async function handleFiles(fileList) {
    clearError();
    var files = Array.prototype.slice.call(fileList);
    if (files.length === 1) return handleFile(files[0]);

    var results = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      try {
        var xml = await fileToXml(f);
        if (!xml) { results.push({ name: f.name, error: "Keine E-Rechnung im PDF gefunden." }); continue; }
        var inv = xmlToInvoice(xml);
        if (inv.error) results.push({ name: f.name, error: inv.error });
        else results.push({ name: f.name, inv: inv });
      } catch (e) {
        results.push({ name: f.name, error: "Datei konnte nicht gelesen werden." });
      }
    }
    renderBatch(results);
  }

  async function handleFile(file) {
    clearError();
    var xml = await fileToXml(file);
    if (xml == null) { showError("In diesem PDF wurde keine eingebettete E-Rechnung (ZUGFeRD/Factur-X) gefunden. Falls Sie eine separate XML-Datei haben, laden Sie diese direkt."); return; }
    processXMLString(xml);
  }

  /* ---------- Events ---------- */
  dropzone.addEventListener("click", function () { fileInput.click(); });
  dropzone.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", function () { if (fileInput.files.length) handleFiles(fileInput.files); });

  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove("drag"); });
  });
  dropzone.addEventListener("drop", function (e) {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  /* ---------- CSV-Export (Semikolon-getrennt, Excel-DE-freundlich) ---------- */
  function csvCell(v) {
    var s = String(v == null ? "" : v);
    if (/[";\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  // Zahl mit deutschem Dezimalkomma (kein Tausenderpunkt, damit Excel sauber importiert)
  function deNum(v) {
    var n = num(v);
    return n == null ? (v == null ? "" : v) : String(n).replace(".", ",");
  }
  // Datum auf ISO (YYYY-MM-DD) normalisieren, damit Excel es als Datum erkennt
  function isoDate(s) {
    if (!s) return "";
    var m = String(s).trim();
    if (/^\d{8}$/.test(m)) return m.slice(0, 4) + "-" + m.slice(4, 6) + "-" + m.slice(6, 8);
    if (/^\d{4}-\d{2}-\d{2}/.test(m)) return m.slice(0, 10);
    return m;
  }
  function buildCSV(inv) {
    var cur = inv.currency || "EUR";
    var rows = [];
    // Kopfdaten
    rows.push(["Rechnungsnummer", inv.id]);
    rows.push(["Rechnungsdatum", isoDate(inv.issueDate)]);
    rows.push(["Faelligkeit", isoDate(inv.dueDate)]);
    rows.push(["Waehrung", cur]);
    rows.push(["Verkaeufer", inv.seller ? inv.seller.name : ""]);
    rows.push(["USt-IdNr. Verkaeufer", inv.seller ? inv.seller.vat : ""]);
    rows.push(["Kaeufer", inv.buyer ? inv.buyer.name : ""]);
    rows.push(["Leitweg-ID/Kaeuferreferenz", inv.buyerRef]);
    rows.push(["Netto gesamt", deNum(inv.totals.taxExcl || inv.totals.net)]);
    rows.push(["Umsatzsteuer", deNum(inv.totals.tax)]);
    rows.push(["Bruttobetrag", deNum(inv.totals.taxIncl)]);
    rows.push(["Zahlbetrag", deNum(inv.totals.payable)]);
    rows.push(["IBAN", inv.iban]);
    rows.push([]); // Leerzeile
    // Positionen
    rows.push(["Pos.", "Bezeichnung", "Menge", "Einheit", "Einzelpreis", "USt %", "Netto"]);
    inv.lines.forEach(function (l, i) {
      rows.push([l.id || (i + 1), l.name, deNum(l.qty), l.unit, deNum(l.price), deNum(l.taxpct), deNum(l.net)]);
    });
    return "﻿" + rows.map(function (r) { return r.map(csvCell).join(";"); }).join("\r\n");
  }
  function downloadCSV(inv) {
    var csv = buildCSV(inv);
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var safe = (inv.id || "rechnung").replace(/[^\w.-]+/g, "_");
    a.href = url; a.download = "rechnung_" + safe + ".csv";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  var csvBtn = $("#csvBtn");
  if (csvBtn) csvBtn.addEventListener("click", function () { if (currentInvoice) downloadCSV(currentInvoice); });

  /* ---------- Batch: Sammel-Tabelle mehrerer Rechnungen ---------- */
  function invSumStatus(inv) {
    var te = num(inv.totals.taxExcl), tx = num(inv.totals.tax), ti = num(inv.totals.taxIncl);
    if (te != null && tx != null && ti != null) return Math.abs((te + tx) - ti) < 0.02 ? "ok" : "bad";
    return "warn";
  }
  function renderBatch(results) {
    currentBatch = results;
    var okCount = results.filter(function (r) { return r.inv; }).length;
    batchCountEl.textContent = okCount + " von " + results.length + " Rechnung(en) gelesen";
    batchBodyEl.innerHTML = results.map(function (r, i) {
      if (r.error) {
        return '<tr class="batch-err"><td>' + esc(r.name) + '</td>' +
          '<td colspan="5" class="muted">⚠ ' + esc(r.error) + '</td><td></td></tr>';
      }
      var inv = r.inv, cur = inv.currency;
      var st = invSumStatus(inv), ico = st === "ok" ? "✓" : st === "bad" ? "✗" : "!";
      return '<tr>' +
        '<td data-label="Datei">' + esc(r.name) + '</td>' +
        '<td data-label="Nr.">' + esc(inv.id || "—") + '</td>' +
        '<td data-label="Datum">' + fmtDate(inv.issueDate) + '</td>' +
        '<td data-label="Verkäufer">' + esc(inv.seller && inv.seller.name ? inv.seller.name : "—") + '</td>' +
        '<td data-label="Brutto" class="num">' + (num(inv.totals.taxIncl) != null ? fmtMoney(inv.totals.taxIncl, cur) : "—") + '</td>' +
        '<td data-label="Prüfung" class="num st-' + st + '">' + ico + '</td>' +
        '<td class="num"><button class="linkbtn" data-idx="' + i + '">Details</button></td>' +
        '</tr>';
    }).join("");
    // Detail-Buttons
    Array.prototype.forEach.call(batchBodyEl.querySelectorAll("button[data-idx]"), function (b) {
      b.addEventListener("click", function () {
        var r = currentBatch[+b.getAttribute("data-idx")];
        if (r && r.inv) showSingle(r.inv);
      });
    });
    resultEl.classList.add("hidden");
    batchEl.classList.remove("hidden");
    batchEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function buildBatchCSV(results) {
    var head = ["Datei", "Rechnungsnummer", "Datum", "Faelligkeit", "Verkaeufer", "USt-IdNr.",
      "Kaeufer", "Netto", "USt", "Brutto", "Zahlbetrag", "Waehrung", "Pruefung"];
    var rows = [head];
    results.forEach(function (r) {
      if (!r.inv) { rows.push([r.name, "FEHLER: " + r.error]); return; }
      var inv = r.inv;
      rows.push([r.name, inv.id, isoDate(inv.issueDate), isoDate(inv.dueDate),
        inv.seller ? inv.seller.name : "", inv.seller ? inv.seller.vat : "",
        inv.buyer ? inv.buyer.name : "",
        deNum(inv.totals.taxExcl || inv.totals.net), deNum(inv.totals.tax),
        deNum(inv.totals.taxIncl), deNum(inv.totals.payable), inv.currency || "EUR",
        invSumStatus(inv) === "ok" ? "ok" : invSumStatus(inv) === "bad" ? "Summenfehler" : "unklar"]);
    });
    return "﻿" + rows.map(function (r) { return r.map(csvCell).join(";"); }).join("\r\n");
  }
  function downloadBatchCSV() {
    if (!currentBatch.length) return;
    var blob = new Blob([buildBatchCSV(currentBatch)], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "rechnungen_sammel_" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  var batchCsvBtn = $("#batchCsvBtn");
  if (batchCsvBtn) batchCsvBtn.addEventListener("click", downloadBatchCSV);
  var batchResetBtn = $("#batchResetBtn");
  if (batchResetBtn) batchResetBtn.addEventListener("click", function () {
    batchEl.classList.add("hidden"); fileInput.value = ""; window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("#printBtn").addEventListener("click", function () { window.print(); });
  $("#resetBtn").addEventListener("click", function () {
    resultEl.classList.add("hidden"); fileInput.value = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("#loadSample").addEventListener("click", function () {
    fetch("samples/beispiel-xrechnung-ubl.xml")
      .then(function (r) { if (!r.ok) throw new Error(); return r.text(); })
      .then(processXMLString)
      .catch(function () { showError("Beispieldatei konnte nicht geladen werden."); });
  });
})();
