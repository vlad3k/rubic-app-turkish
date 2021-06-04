import { Component, Input } from '@angular/core';
import BigNumber from 'bignumber.js';
import { InstantTradeSwapInput } from '../../../../models/instant-trade-input';
import { InstantTradeProviderController } from '../../../../models/instant-trades-provider-controller';
import { BLOCKCHAIN_NAME } from '../../../../../../../shared/models/blockchain/BLOCKCHAIN_NAME';
import { AuthService } from '../../../../../../../core/services/auth/auth.service';
import { ProviderConnectorService } from '../../../../../../../core/services/blockchain/provider-connector/provider-connector.service';

@Component({
  selector: 'app-iframe-tokens-swap-input',
  templateUrl: './iframe-tokens-swap-input.component.html',
  styleUrls: ['./iframe-tokens-swap-input.component.scss']
})
export class IframeTokensSwapInputComponent extends InstantTradeSwapInput {
  @Input() public disableSelection: boolean;

  public get tradeController(): InstantTradeProviderController {
    return this.trades[this.index];
  }

  public get isLoggedIn(): boolean {
    return Boolean(this.providerConnectorService.address);
  }

  public get gasFeeDisplayCondition(): BigNumber | undefined {
    return (
      this.blockchain !== BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN &&
      this.blockchain !== BLOCKCHAIN_NAME.POLYGON &&
      this.tradeController?.trade?.gasFeeInEth &&
      this.tradeController?.trade?.gasFeeInUsd
    );
  }

  constructor(
    private readonly authService: AuthService,
    private readonly providerConnectorService: ProviderConnectorService
  ) {
    super();
    this.disableSelection = false;
  }

  public async login(): Promise<void> {
    await this.authService.serverlessSignIn();
  }
}
