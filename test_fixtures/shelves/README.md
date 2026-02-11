# Test Shelf Images

Place shelf photos here for automated testing.

## Quick Start

**Easiest method**: Use the app's regular "Import photo" button to select from your Photos library. The test images are already on your Mac.

**Alternative**: Use Settings → Developer → "Load Test Fixture" (requires setup below)

## Setup for Load Test Fixture Button

To use the "Load Test Fixture" button in Developer settings:

1. **AirDrop to iPhone**:
   - AirDrop `shelf_001.jpg` and `shelf_002.jpg` to your iPhone
   - Save them to Photos

2. **Or use Finder** (macOS Catalina+):
   - Connect iPhone to Mac
   - Open Finder, select iPhone
   - Go to Files → BookScanner
   - Create folder "TestFixtures"
   - Drag the .jpg files there

## Files

- `shelf_001.jpg` - Mystery shelf (vertical spines) - ~2.8 MB
- `shelf_002.jpg` - Mystery & Crime shelf (horizontal) - ~3.4 MB
- `shelve_samples/` - Original HEIC files

## Test Cases

### shelf_001.jpg (20 books)
- Nicholas Sparks - Escape
- Patricia Wentworth - Dead or Alive
- Sara Paretsky - Killing Orders ⚠️ (was failing with Score=0)
- Faye Kellerman - Straight Into Darkness
- Ian Rankin - Knots and Crosses
- Lisa Gardner - Before She Disappeared
- John Grisham - The Guardians
- Ngaio Marsh - Overture to Death, The Fingerprint, Death in a White Tie, etc.
- Patricia Wentworth - Poison in the Pen
- Aaron Elkins - A Deceptive Clarity
- Lisa Childs - The Buried
- Stuart Woods - Swimming to Catalina
- Christina Dodd - She Knows
- John Sandford - Lightning

### shelf_002.jpg (50+ books)
Three columns of books including:
- James Patterson (multiple)
- John Sandford - Deadline, Rough Country, Heat Lightning
- Stuart Woods - Swimming to Catalina
- Lisa Gardner, Lisa Childs
- Ian Rankin - Falls, Knots and Crosses
- John Grisham - The Guardians, A Time for Mercy, The Street Lawyer
- Stieg Larsson - The Girl Who Played with Fire
- Clive Cussler - The Oracle
- Robert Harris - Fatherland
- And many more mystery/crime titles
