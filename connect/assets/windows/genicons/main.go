// Command genicons renders the Windows client's icons from the AIQSA icon
// (public/icon-512.png): the program icon and the three tray icons, which
// add a status dot (connected, waiting, not connected). generate.sh feeds
// them to go-winres. Only the standard library is used, so the output is
// the same on every machine.
//
//	go run ./assets/windows/genicons -src ../public/icon-512.png -out <dir>
package main

import (
	"errors"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

// Sizes Windows picks from: the program icon for Explorer and Apps, the
// tray icons for the notification area at 100-300% scaling.
var (
	appSizes  = []int{256, 64, 48, 40, 32, 24, 20, 16}
	traySizes = []int{48, 40, 32, 24, 20, 16}
)

// Status dots. The ring is the icon's background colour (public/icon.svg),
// so the dot stays apart from the glyph.
var (
	ringColor = rgb(0x1a, 0x1b, 0x1e)
	dots      = map[string]color.NRGBA{
		"connected":    rgb(0x22, 0xc5, 0x5e),
		"waiting":      rgb(0xf5, 0x9e, 0x0b),
		"disconnected": rgb(0x9c, 0xa3, 0xaf),
	}
)

func rgb(r, g, b uint8) color.NRGBA { return color.NRGBA{R: r, G: g, B: b, A: 0xff} }

func main() {
	src := flag.String("src", "", "the 512x512 AIQSA icon (public/icon-512.png)")
	out := flag.String("out", "", "the folder to write the PNG files to")
	flag.Parse()
	if err := run(*src, *out); err != nil {
		fmt.Fprintln(os.Stderr, "genicons:", err)
		os.Exit(1)
	}
}

func run(src, out string) error {
	if src == "" || out == "" {
		return errors.New("-src and -out are required")
	}
	base, err := load(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	for _, size := range appSizes {
		if err := save(filepath.Join(out, fmt.Sprintf("app-%d.png", size)), resize(base, size)); err != nil {
			return err
		}
	}
	for name, dot := range dots {
		marked := withDot(base, dot)
		for _, size := range traySizes {
			if err := save(filepath.Join(out, fmt.Sprintf("%s-%d.png", name, size)), resize(marked, size)); err != nil {
				return err
			}
		}
	}
	return nil
}

// canvas is a square image with premultiplied, linear-in-sRGB-values
// channels in [0, 1].
type canvas struct {
	size int
	px   [][4]float64
}

func load(path string) (*canvas, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	if b.Dx() != b.Dy() || b.Dx() < 256 {
		return nil, fmt.Errorf("%s must be a square image of at least 256 pixels", path)
	}
	c := &canvas{size: b.Dx(), px: make([][4]float64, b.Dx()*b.Dy())}
	for y := 0; y < c.size; y++ {
		for x := 0; x < c.size; x++ {
			r, g, bl, a := img.At(b.Min.X+x, b.Min.Y+y).RGBA() // premultiplied
			c.px[y*c.size+x] = [4]float64{float64(r) / 0xffff, float64(g) / 0xffff, float64(bl) / 0xffff, float64(a) / 0xffff}
		}
	}
	return c, nil
}

// withDot paints a status dot with a ring at the bottom right.
func withDot(base *canvas, dot color.NRGBA) *canvas {
	c := &canvas{size: base.size, px: append([][4]float64(nil), base.px...)}
	s := float64(c.size)
	ringRadius, dotRadius := 0.275*s, 0.21*s
	cx, cy := s-ringRadius, s-ringRadius
	paintDisc(c, cx, cy, ringRadius, ringColor)
	paintDisc(c, cx, cy, dotRadius, dot)
	return c
}

// paintDisc composites an anti-aliased disc (4x4 samples per pixel) over c.
func paintDisc(c *canvas, cx, cy, radius float64, col color.NRGBA) {
	const samples = 4
	fill := [4]float64{float64(col.R) / 255, float64(col.G) / 255, float64(col.B) / 255, 1}
	minX, maxX := max(0, int(cx-radius)-1), min(c.size-1, int(cx+radius)+1)
	minY, maxY := max(0, int(cy-radius)-1), min(c.size-1, int(cy+radius)+1)
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			inside := 0
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					px := float64(x) + (float64(sx)+0.5)/samples
					py := float64(y) + (float64(sy)+0.5)/samples
					if math.Hypot(px-cx, py-cy) <= radius {
						inside++
					}
				}
			}
			coverage := float64(inside) / (samples * samples)
			if coverage == 0 {
				continue
			}
			p := &c.px[y*c.size+x]
			for i := range 4 {
				p[i] = fill[i]*coverage + p[i]*(1-coverage)
			}
		}
	}
}

// resize scales c down to size with an area filter: every target pixel
// averages the source area it covers, partly covered pixels by fraction.
func resize(c *canvas, size int) *image.NRGBA {
	weights := areaWeights(c.size, size)
	// Horizontal pass, then vertical.
	tmp := make([][4]float64, size*c.size)
	for y := 0; y < c.size; y++ {
		for x := 0; x < size; x++ {
			var sum [4]float64
			for _, w := range weights[x] {
				p := c.px[y*c.size+w.index]
				for i := range 4 {
					sum[i] += p[i] * w.weight
				}
			}
			tmp[y*size+x] = sum
		}
	}
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var sum [4]float64
			for _, w := range weights[y] {
				p := tmp[w.index*size+x]
				for i := range 4 {
					sum[i] += p[i] * w.weight
				}
			}
			img.SetNRGBA(x, y, unpremultiply(sum))
		}
	}
	return img
}

type weight struct {
	index  int
	weight float64
}

func areaWeights(from, to int) [][]weight {
	scale := float64(from) / float64(to)
	out := make([][]weight, to)
	for i := range to {
		start, end := float64(i)*scale, float64(i+1)*scale
		for j := int(start); j < from && float64(j) < end; j++ {
			overlap := math.Min(end, float64(j+1)) - math.Max(start, float64(j))
			if overlap > 0 {
				out[i] = append(out[i], weight{index: j, weight: overlap / scale})
			}
		}
	}
	return out
}

func unpremultiply(p [4]float64) color.NRGBA {
	a := p[3]
	if a <= 0 {
		return color.NRGBA{}
	}
	channel := func(v float64) uint8 { return uint8(math.Round(math.Min(1, v/a) * 255)) }
	return color.NRGBA{R: channel(p[0]), G: channel(p[1]), B: channel(p[2]), A: uint8(math.Round(math.Min(1, a) * 255))}
}

func save(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	encoder := png.Encoder{CompressionLevel: png.BestCompression}
	if err := encoder.Encode(f, img); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
