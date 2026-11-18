// Package fixture is check-licenses.test.sh's MIT-licensed module that
// depends on one MPL-2.0 module, example.com/mpl-fixture v1.9.0, vendored
// here (vendor/), so the check finds its version with no network.
package fixture

import _ "example.com/mpl-fixture"
