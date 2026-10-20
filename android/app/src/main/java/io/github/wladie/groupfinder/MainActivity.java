package io.github.wladie.groupfinder;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareInPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
