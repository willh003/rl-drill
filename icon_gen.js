// Draws the app icon. Run:  osascript -l JavaScript icon_gen.js /path/out.png
// Everything here is base-system AppKit drawing -- no image assets to lose.
ObjC.import('Cocoa');

var args = ObjC.unwrap($.NSProcessInfo.processInfo.arguments)
    .map(function (a) { return ObjC.unwrap(a); });
var OUT = args[args.length - 1];
var S = 1024;

function rgb(r, g, b, a) {
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha(r/255, g/255, b/255, a === undefined ? 1 : a);
}

var img = $.NSImage.alloc.initWithSize($.NSMakeSize(S, S));
img.lockFocus;

// macOS-style rounded tile, inset slightly like a real app icon
var inset = S * 0.06, r = S * 0.225;
var tile = $.NSMakeRect(inset, inset, S - inset * 2, S - inset * 2);
var path = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(tile, r, r);
rgb(26, 26, 30).set;
path.fill;
rgb(70, 70, 78).set;
path.lineWidth = S * 0.007;
path.stroke;

// A sigma as the hero mark, optically centred a little above middle so the
// card stack below it has room to breathe.
var attrs = $.NSMutableDictionary.alloc.init;
attrs.setObjectForKey($.NSFont.systemFontOfSizeWeight(S * 0.40, $.NSFontWeightMedium),
                      $.NSFontAttributeName);
attrs.setObjectForKey(rgb(242, 242, 247), $.NSForegroundColorAttributeName);
var glyph = $.NSString.alloc.initWithUTF8String('Σ');
var gs = glyph.sizeWithAttributes(attrs);
glyph.drawAtPointWithAttributes(
    $.NSMakePoint((S - gs.width) / 2, S * 0.60 - gs.height / 2), attrs);

// A short stack of cards underneath: top one green, so the mark reads as a
// deck rather than just a letter. Deliberately clear of the glyph.
var barW = S * 0.36, barH = S * 0.050, bx = (S - barW) / 2;
[[S * 0.305, rgb(48, 209, 88)],
 [S * 0.232, rgb(90, 90, 98)],
 [S * 0.159, rgb(58, 58, 64)]].forEach(function (row) {
    var rp = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
        $.NSMakeRect(bx, row[0], barW, barH), barH * 0.42, barH * 0.42);
    row[1].set;
    rp.fill;
});

img.unlockFocus;

var tiff = img.TIFFRepresentation;
var rep = $.NSBitmapImageRep.imageRepWithData(tiff);
rep.size = $.NSMakeSize(S, S);
var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
png.writeToFileAtomically(OUT, true);
