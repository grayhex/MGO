# Siemens S65

The 2004 silver and graphite model has a 109 × 48 × 18 mm body and a 132×176 LCD. The front has two dotted soft keys, a five-way joystick and a twelve-key Latin keypad with three tapered columns. The Call, End/Power and service shortcut keys are drawn and have no Java ME binding. [Mobile-review](https://www.mobile-review.com/review/siemens-s65-en.shtml)

- The primary reference is Afrank99's 2182×3504 front photograph. It shows the trapezoidal mesh earpiece, the silver rails, the printing and the positions of the individual controls. SHA-256 `a0fe3a18ae4144a270ae167b659b9aad525124f08c140e479870feaf75cbe12c`. [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Siemens_S65_AF.jpg) · [CC BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/)
- The independent Mobile-review photographs confirm the front silhouette and the relief of the joystick and keycaps. SHA-256 `da58ac5abc254b92f9fce4ec206ec7efa1c46eefe3cc2336abcc051a88c820d7` (front and sides) and `7518495e5a7431779c2b75f4df94e1aa812e0b731167268cd343ffefd476b982` (keypad). [Body photograph](https://www.mobile-review.com/review/image/siemens/s65/pic1.jpg) · [Keypad photograph](https://www.mobile-review.com/review/image/siemens/s65/pic4.jpg)

The new illustration is in `design/phones/siemens-s65/source.png`. Run `python3 tools/phones/export_measured.py siemens-s65` to recreate the images and polygons. The close-up is cropped from the same body, and both active LCD windows have the exact 3:4 aspect ratio. The joystick sectors divide its continuous physical surface into directional actions. [Artwork attribution](ATTRIBUTION.txt)

Java ME uses KEmulator's existing Siemens CX75 preset at 132×176 with the Siemens layout. The pinned KEmulator has no dedicated S65 preset.
