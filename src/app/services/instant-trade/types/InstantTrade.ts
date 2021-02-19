import {InstantTradeToken} from './index';
import BigNumber from 'bignumber.js';

interface InstantTrade {
    from: {
        token: InstantTradeToken;
        /**
         * Amount of input in absolute token units (WITHOUT decimals)
         */
        amount: BigNumber;
    };
    to: {
        token: InstantTradeToken;
        /**
         * Amount of output without slippage in absolute token units (WITHOUT decimals)
         */
        amount: BigNumber;
    };

    /**
     * Amount of predicted gas limit in absolute gas units
     */
    estimatedGas: BigNumber;

    /**
     * Amount of predicted gas fee in usd$
     */
    gasFee: BigNumber;
}

export default InstantTrade;
