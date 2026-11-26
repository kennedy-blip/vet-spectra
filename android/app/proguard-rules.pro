# Capacitor plugin bridge — keep the @CapacitorPlugin annotated classes.
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class com.vetspectra.plugins.** { *; }
-keepclassmembers class * { @com.getcapacitor.PluginMethod public *; }
