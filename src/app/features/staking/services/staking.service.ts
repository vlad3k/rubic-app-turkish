import { Inject, Injectable, Injector } from '@angular/core';
import {
  BehaviorSubject,
  combineLatest,
  EMPTY,
  forkJoin,
  from,
  interval,
  Observable,
  of
} from 'rxjs';
import {
  catchError,
  filter,
  finalize,
  first,
  map,
  startWith,
  switchMap,
  take,
  tap
} from 'rxjs/operators';
import BigNumber from 'bignumber.js';
import { TuiDialogService } from '@taiga-ui/core';

import { BLOCKCHAIN_NAME } from '@shared/models/blockchain/blockchain-name';
import { STAKING_CONTRACT_ABI } from 'src/app/features/staking/constants/xbrbc-contract-abi';
import { PolymorpheusComponent } from '@tinkoff/ng-polymorpheus';
import { TransactionReceipt } from 'web3-eth';
import { StakingApiService } from '@features/staking/services/staking-api.service';
import { AuthService } from '@app/core/services/auth/auth.service';
import { ErrorsService } from '@core/errors/errors.service';
import { NotificationsService } from '@core/services/notifications/notifications.service';
import { PublicBlockchainAdapterService } from '@core/services/blockchain/blockchain-adapters/public-blockchain-adapter.service';
import { PrivateBlockchainAdapterService } from '@core/services/blockchain/blockchain-adapters/private-blockchain-adapter.service';
import { BinancePolygonRubicBridgeProviderService } from '@features/bridge/services/bridge-service/blockchains-bridge-provider/binance-polygon-bridge-provider/binance-polygon-rubic-bridge-provider/binance-polygon-rubic-bridge-provider.service';
import { EthereumBinanceRubicBridgeProviderService } from '@features/bridge/services/bridge-service/blockchains-bridge-provider/ethereum-binance-bridge-provider/rubic-bridge-provider/ethereum-binance-rubic-bridge-provider.service';
import { TokensApiService } from '@core/services/backend/tokens-api/tokens-api.service';
import { ENVIRONMENT } from 'src/environments/environment';
import { Web3Pure } from '@core/services/blockchain/blockchain-adapters/common/web3-pure';
import { SwapModalComponent } from '@features/staking/components/swap-modal/swap-modal.component';
import { ERROR_TYPE } from '@core/errors/models/error-type';
import { BRIDGE_PROVIDER } from '@shared/models/bridge/bridge-provider';
import { BridgeTrade } from '@features/bridge/models/bridge-trade';
import { MinimalToken } from '@shared/models/tokens/minimal-token';
import { TokensService } from '@core/services/tokens/tokens.service';
import { RubicError } from '@core/errors/models/rubic-error';
import { TOKEN_RANK } from '@shared/models/tokens/token-rank';
import { STAKING_TOKENS } from '@features/staking/constants/staking-tokens';

@Injectable()
export class StakingService {
  /**
   * User's wallet address.
   */
  private walletAddress: string;

  /**
   * Staking contract address.
   */
  private readonly stakingContractAddress = ENVIRONMENT.staking.stakingContractAddress;

  /**
   * Contract address for staking via bridge [from api].
   */
  private bridgeContractAddress: string;

  /**
   * Amount with rewards [from contract].
   */
  private readonly _amountWithRewards$ = new BehaviorSubject<BigNumber>(new BigNumber(0));

  public readonly amountWithRewards$ = this._amountWithRewards$.asObservable();

  /**
   * Current APR [from api].
   */
  private readonly _apr$ = new BehaviorSubject<number>(0);

  public readonly apr$ = this._apr$.asObservable();

  /**
   * Staking refill time [currently unused].
   */
  private readonly _refillTime$ = new BehaviorSubject<string>('');

  public readonly refillTime$ = this._refillTime$.asObservable();

  /**
   * How much RBC user already staked [from contract].
   */
  private readonly _userEnteredAmount$ = new BehaviorSubject<number>(0);

  public readonly userEnteredAmount$ = this._userEnteredAmount$.asObservable();

  /**
   * Total RBC amount in stake [from contract].
   */
  private readonly _totalRBCEntered$ = new BehaviorSubject<number>(0);

  public readonly totalRBCEntered$ = this._totalRBCEntered$.asObservable();

  /**
   * Grouped totalRbcEntered$ and userEnteredAnount$ [from contract].
   */
  public readonly stakingProgress$ = combineLatest([
    this._totalRBCEntered$,
    this._userEnteredAmount$
  ]).pipe(map(([totalRbcEntered, userEnteredAmount]) => ({ totalRbcEntered, userEnteredAmount })));

  /**
   * User's xBRBC balance [from contract].
   */
  private readonly _stakingTokenBalance$ = new BehaviorSubject<BigNumber>(new BigNumber(0));

  public readonly stakingTokenBalance$ = this._stakingTokenBalance$.asObservable();

  /**
   * Earned rewards [from contract].
   */
  private readonly _earnedRewards$ = new BehaviorSubject<BigNumber>(new BigNumber(0));

  public readonly earnedRewards$ = this._earnedRewards$.asObservable();

  /**
   * Current token selected for stake.
   */
  private readonly _selectedToken$ = new BehaviorSubject<MinimalToken>(undefined);

  public readonly selectedToken$ = this._selectedToken$.asObservable();

  get selectedToken(): MinimalToken {
    return this._selectedToken$.getValue();
  }

  /**
   * User's max amount for unstake [from contract].
   */
  private readonly _maxAmountForWithdraw$ = new BehaviorSubject<BigNumber>(new BigNumber(0));

  public readonly maxAmountForWithdraw$ = this._maxAmountForWithdraw$.asObservable();

  /**
   * Users deposit [from api].
   */
  private readonly _usersTotalDeposit$ = new BehaviorSubject<BigNumber>(new BigNumber(0));

  /**
   * Utility Subj to trigger token balance update.
   */
  private readonly updateTokenBalance$ = new BehaviorSubject<void>(null);

  /**
   * BRBC usd price [from api].
   */
  private BRBCUsdPrice: number;

  /**
   * BRBC token usd price update time.
   */
  private BRBC_USD_PRICE_UPDATE_TIME = 600000;

  /**
   * Is user need to connect wallet.
   */
  public readonly needLogin$ = this.authService.getCurrentUser().pipe(map(user => !user?.address));

  /**
   * Loading state for whole progress block.
   */
  public readonly stakingProgressLoading$ = new BehaviorSubject<boolean>(true);

  /**
   * Loading state for whole statistics block.
   */
  public readonly stakingStatisticsLoading$ = new BehaviorSubject<boolean>(false);

  /**
   * Balance of token selected for stake [from contract].
   */
  public readonly selectedTokenBalance$ = combineLatest([
    this.selectedToken$,
    this.needLogin$,
    this.updateTokenBalance$.asObservable()
  ]).pipe(
    switchMap(([selectedToken, needLogin]) => {
      if (needLogin) {
        this._amountWithRewards$.next(new BigNumber(0));
        this._earnedRewards$.next(new BigNumber(0));
        this._stakingTokenBalance$.next(new BigNumber(0));
        return of(new BigNumber(0));
      }
      return this.getSelectedTokenBalance(selectedToken);
    })
  );

  constructor(
    private readonly web3PublicService: PublicBlockchainAdapterService,
    private readonly web3PrivateService: PrivateBlockchainAdapterService,
    private readonly authService: AuthService,
    private readonly stakingApiService: StakingApiService,
    private readonly tokensApiService: TokensApiService,
    private readonly tokensService: TokensService,
    private readonly errorService: ErrorsService,
    private readonly notificationsService: NotificationsService,
    private readonly polygonBinanceBridge: BinancePolygonRubicBridgeProviderService,
    private readonly ethereumBinanceBridge: EthereumBinanceRubicBridgeProviderService,
    @Inject(TuiDialogService) private readonly dialogService: TuiDialogService,
    @Inject(Injector) private readonly injector: Injector
  ) {
    forkJoin([this.getTotalRBCEntered(), this.getApr(), this.getRefillTime()]).subscribe(() =>
      this.stakingProgressLoading$.next(false)
    );

    this.authService
      .getCurrentUser()
      .pipe(
        filter(Boolean),
        take(1),
        tap(({ address }) => (this.walletAddress = address)),
        switchMap(() => {
          return forkJoin([
            this.getStakingTokenBalance().pipe(
              switchMap(stakingTokenBalance => this.getAmountWithRewards(stakingTokenBalance))
            ),
            this.getUserEnteredAmount(),
            this.getMaxAmountForWithdraw()
          ]);
        }),
        switchMap(([amountWithRewards]) => this.getEarnedRewards(amountWithRewards))
      )
      .subscribe(() => this.stakingStatisticsLoading$.next(false));

    this.stakingApiService.getBridgeContractAddress().subscribe(address => {
      this.bridgeContractAddress = address;
    });
  }

  /**
   * Set what token user going to stake.
   * @param token Token that user selected to stake.
   */
  public setToken(token: MinimalToken): void {
    this._selectedToken$.next(token);
  }

  /**
   * Enter stake with provided amount of tokens.
   * @param amount Amount of tokens that user wants to stake.
   * @return Observable<TransactionReceipt | number>
   */
  public enterStake(amount: BigNumber): Observable<TransactionReceipt | unknown> {
    const tokenBlockchain = this.selectedToken.blockchain;
    const needSwap =
      tokenBlockchain !== BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN_TESTNET &&
      tokenBlockchain !== BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN;
    const amountInWei = Web3Pure.toWei(amount);

    if (needSwap) {
      return this.openSwapModal(amount, tokenBlockchain);
    } else {
      return from(
        this.web3PrivateService[BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN].tryExecuteContractMethod(
          this.stakingContractAddress,
          STAKING_CONTRACT_ABI,
          'enter',
          [amountInWei]
        )
      ).pipe(
        catchError((error: unknown) => {
          this.errorService.catchAnyError(error as Error);
          return EMPTY;
        }),
        switchMap(receipt => this.updateUsersDeposit(amountInWei, receipt.transactionHash)),
        switchMap(() => this.reloadStakingProgress()),
        switchMap(() => this.reloadStakingStatistics()),
        tap(() => this.updateTokenBalance$.next())
      );
    }
  }

  /**
   * Leave stake and withdraw provided amount of xBRBC.
   * @param amount Amount of tokens that user wants to withdraw.
   * @return Observable<unknown>
   */
  public leaveStake(amount: BigNumber): Observable<unknown> {
    const amountInWei = Web3Pure.toWei(amount);
    return from(
      this.web3PrivateService[BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN].tryExecuteContractMethod(
        this.stakingContractAddress,
        STAKING_CONTRACT_ABI,
        'leave',
        [amountInWei]
      )
    ).pipe(
      switchMap(receipt =>
        this.updateUsersDepositAfterWithdraw(amountInWei, receipt.transactionHash)
      ),
      switchMap(() => forkJoin([this.reloadStakingStatistics(), this.reloadStakingProgress()])),
      switchMap(() => this.getMaxAmountForWithdraw())
    );
  }

  /**
   * Check if user need to approve tokens before entering stake.
   * @param amount Amount of tokens that user wants to stake.
   * @return Observable<boolean>
   */
  public needApprove(amount: BigNumber): Observable<boolean> {
    return from(
      this.web3PublicService[this.selectedToken.blockchain].getAllowance({
        tokenAddress: this.selectedToken.address,
        ownerAddress: this.walletAddress,
        spenderAddress: this.stakingContractAddress
      })
    ).pipe(map(allowance => allowance.lt(Web3Pure.fromWei(amount))));
  }

  /**
   * Approve tokens for infinity amount.
   * @return Observable<TransactionReceipt>
   */
  public approveTokens(): Observable<TransactionReceipt> {
    return from(
      this.web3PrivateService[BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN].approveTokens(
        this.selectedToken.address,
        this.stakingContractAddress,
        'infinity'
      )
    ).pipe(
      catchError((error: unknown) => {
        this.errorService.catch(error as RubicError<ERROR_TYPE.TEXT>);
        return EMPTY;
      })
    );
  }

  /**
   * Get staking token (xBRBC) balance from blockchain.
   * @return Observable<BigNumber>
   */
  public getStakingTokenBalance(): Observable<BigNumber> {
    return from(
      this.web3PublicService[BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN].getTokenBalance(
        this.walletAddress,
        this.stakingContractAddress
      )
    ).pipe(
      catchError((error: unknown) => {
        this.errorService.catch(error as RubicError<ERROR_TYPE.TEXT>);
        return of(new BigNumber('0'));
      }),
      tap(balance => this._stakingTokenBalance$.next(Web3Pure.fromWei(balance)))
    );
  }

  /**
   * Get staking token balance without freezing tokens (max amount user can withdraw right now).
   * @return Observable<BigNumber>
   */
  public getMaxAmountForWithdraw(): Observable<BigNumber> {
    return from(
      this.web3PublicService[BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN].callContractMethod(
        this.stakingContractAddress,
        STAKING_CONTRACT_ABI,
        'actualBalanceOf',
        {
          methodArguments: [this.walletAddress],
          from: this.walletAddress
        }
      )
    ).pipe(
      map(actualBalance => Web3Pure.fromWei(actualBalance)),
      tap(actualBalance => this._maxAmountForWithdraw$.next(actualBalance))
    );
  }

  /**
   * Reloads staking token balance, earned rewards, amount with rewards, apr.
   * @return Observable<number | BigNumber>
   */
  public reloadStakingStatistics(): Observable<number | BigNumber> {
    this.stakingStatisticsLoading$.next(true);
    this.getApr().subscribe();
    return this.needLogin$.pipe(
      take(1),
      switchMap(needLogin => {
        if (needLogin) {
          return EMPTY;
        }
        return this.getStakingTokenBalance().pipe(
          switchMap(stakingTokenBalance => this.getAmountWithRewards(stakingTokenBalance)),
          switchMap(() => this.getEarnedRewards())
        );
      }),
      finalize(() => this.stakingStatisticsLoading$.next(false))
    );
  }

  /**
   * Reloads total RBC entered & user entered amount.
   * @return Observable<unknown>
   */
  public reloadStakingProgress(): Observable<unknown> {
    this.stakingProgressLoading$.next(true);
    return this.needLogin$.pipe(
      take(1),
      switchMap(needLogin => {
        if (needLogin) {
          return this.getTotalRBCEntered();
        }
        return forkJoin([this.getTotalRBCEntered(), this.getUserEnteredAmount()]);
      }),
      finalize(() => this.stakingProgressLoading$.next(false))
    );
  }

  /**
   * Gets balance of selected token from blockchain.
   * @param token Selected token.
   * @return Observable<BigNumber>
   */
  private getSelectedTokenBalance(token: MinimalToken): Observable<BigNumber> {
    return from(
      this.web3PublicService[token.blockchain].getTokenBalance(this.walletAddress, token.address)
    ).pipe(
      catchError((error: unknown) => {
        this.errorService.catch(error as RubicError<ERROR_TYPE.TEXT>);
        return EMPTY;
      }),
      map(balance => Web3Pure.fromWei(balance))
    );
  }

  /**
   * Calculates what amount of BRBC user will get if withdraw provided amount of xBRBC.
   * @param amount Amount of tokens that user wants to withdraw.
   * @return Observable<BigNumber>
   */
  public calculateLeaveReward(amount: BigNumber): Observable<BigNumber> {
    if (amount.isZero()) {
      return of(new BigNumber(0));
    }
    return from(
      this.web3PublicService[BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN].callContractMethod(
        this.stakingContractAddress,
        STAKING_CONTRACT_ABI,
        'canReceive',
        {
          methodArguments: [amount.toFixed(0)],
          from: this.walletAddress
        }
      )
    ).pipe(
      catchError(() => EMPTY),
      map(res => Web3Pure.fromWei(res))
    );
  }

  /**
   * Enters stake via Rubic bridge.
   * @param amount Amount of tokens that user wants to stake.
   * @return Observable<TransactionReceipt>
   */
  public enterStakeViaBridge(amount: BigNumber): Observable<TransactionReceipt> {
    const fromBlockchain = this.selectedToken.blockchain;
    const bridgeTrade = this.getBridgeTradeObject(fromBlockchain, amount);

    return this.getRubicBridge(fromBlockchain).createTrade(bridgeTrade);
  }

  /**
   * Checks if Rubic bridge need approve.
   * @param amount Amount of tokens that user wants to stake.
   * @return Observable<boolean>
   */
  public needBridgeApprove(amount: BigNumber): Observable<boolean> {
    const fromBlockchain = this.selectedToken.blockchain;
    const bridgeTrade = this.getBridgeTradeObject(fromBlockchain, amount);

    return this.getRubicBridge(fromBlockchain).needApprove(bridgeTrade);
  }

  /**
   * Approves tokens for bridge.
   * @param amount BRBC amount to approve.
   * @return Observable<TransactionReceipt>
   */
  public approveBridgeTokens(amount: BigNumber): Observable<TransactionReceipt> {
    const fromBlockchain = this.selectedToken.blockchain;
    const bridgeTrade = this.getBridgeTradeObject(fromBlockchain, amount);

    return this.getRubicBridge(fromBlockchain).approve(bridgeTrade);
  }

  /**
   * Gets usd price of provided amount of BRBC tokens.
   * @param amount Contracts "canReceive" method response.
   */
  public calculateBRBCUsdPrice(amount: BigNumber): BigNumber {
    return amount.multipliedBy(this.BRBCUsdPrice);
  }

  /**
   * Gets amount with rewards from blockchain.
   * @param stakingTokenBalance Balance of xBRBC token.
   * @return Observable<BigNumber>
   */
  private getAmountWithRewards(stakingTokenBalance: BigNumber): Observable<BigNumber> {
    return this.calculateLeaveReward(stakingTokenBalance).pipe(
      catchError((error: unknown) => {
        this.errorService.catchAnyError(error as RubicError<ERROR_TYPE.TEXT>);
        return of(new BigNumber(0));
      }),
      tap(actualBalance => {
        this._amountWithRewards$.next(actualBalance);
      })
    );
  }

  /**
   * Gets earned rewards from blockchain.
   * @return Observable<BigNumber>
   */
  private getEarnedRewards(amountWithRewards?: BigNumber): Observable<BigNumber> {
    return combineLatest([
      this.getUsersDeposit(),
      amountWithRewards ? of(amountWithRewards) : this._amountWithRewards$
    ]).pipe(
      first(),
      map(([usersDeposit, totalAmount]) => {
        const usersDepositInTokens = Web3Pure.fromWei(usersDeposit);
        const earnedRewards = totalAmount.minus(usersDepositInTokens);
        if (earnedRewards.s === -1 || earnedRewards.s === null) {
          return new BigNumber(0);
        }
        return earnedRewards;
      }),
      tap(earnedRewards => this._earnedRewards$.next(earnedRewards))
    );
  }

  /**
   * Gets user entered amount from blockchain.
   * @return Observable<number>
   */
  private getUserEnteredAmount(): Observable<number> {
    return from(
      this.web3PublicService[BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN].callContractMethod(
        this.stakingContractAddress,
        STAKING_CONTRACT_ABI,
        'userEnteredAmount',
        {
          methodArguments: [this.walletAddress]
        }
      )
    ).pipe(
      catchError((error: unknown) => {
        console.debug('user entered amount');
        this.errorService.catch(error as RubicError<ERROR_TYPE.TEXT>);
        return EMPTY;
      }),
      map(amount => Web3Pure.fromWei(amount).toNumber()),
      tap(userEnteredAmount => this._userEnteredAmount$.next(userEnteredAmount))
    );
  }

  /**
   * Gets total RBC entered from blockchain.
   * @return Observable<string>
   */
  private getTotalRBCEntered(): Observable<string> {
    return from(
      this.web3PublicService[BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN].callContractMethod(
        this.stakingContractAddress,
        STAKING_CONTRACT_ABI,
        'totalRBCEntered'
      )
    ).pipe(
      catchError((error: unknown) => {
        console.debug('get total rbc entered');
        this.errorService.catch(error as RubicError<ERROR_TYPE.TEXT>);
        return EMPTY;
      }),
      tap(totalRbcEntered =>
        this._totalRBCEntered$.next(Web3Pure.fromWei(+totalRbcEntered).toNumber())
      )
    );
  }

  /**
   * Gets staking APR from api.
   * @return Observable<number>
   */
  private getApr(): Observable<number> {
    return this.stakingApiService.getApr().pipe(
      catchError((err: unknown) => {
        console.debug(err);
        return EMPTY;
      }),
      tap(apr => this._apr$.next(apr))
    );
  }

  /**
   * Gets refill time from api.
   * @return Observable<string>
   */
  private getRefillTime(): Observable<string> {
    return this.stakingApiService
      .getRefillTime()
      .pipe(tap(refillTime => this._refillTime$.next(refillTime)));
  }

  /**
   * Gets user's deposit from api.
   * @return Observable<number>
   */
  private getUsersDeposit(): Observable<number> {
    return this.stakingApiService
      .getUsersDeposit(this.walletAddress)
      .pipe(tap(deposit => this._usersTotalDeposit$.next(new BigNumber(deposit))));
  }

  /**
   * Updates user's deposit on backend after entering stake.
   * @param amount Amount that user staked.
   * @param txHash Transaction hash.
   * @return Observable<void>
   */
  private updateUsersDeposit(amount: string, txHash: string): Observable<void> {
    return this.stakingApiService.updateUsersDeposit({
      walletAddress: this.walletAddress,
      amount,
      txHash,
      network: 'binance-smart-chain'
    });
  }

  /**
   * Updates user's deposit on backend after leaving stake.
   * @param amount Amount that user unstaked.
   * @param txHash Transaction hash.
   * @return Observable<void>
   */
  private updateUsersDepositAfterWithdraw(amount: string, txHash: string): Observable<void> {
    return this.stakingApiService.updateUsersDepositAfterWithdraw({
      walletAddress: this.walletAddress,
      amount,
      txHash,
      network: 'binance-smart-chain'
    });
  }

  /**
   * Opens swap dialog.
   * @param amount Amount that user wants to stake via bridge
   * @param blockchain Blockchain of selected token.
   * @return Observable<unknown>
   */
  private openSwapModal(amount: BigNumber, blockchain: BLOCKCHAIN_NAME): Observable<unknown> {
    return this.dialogService.open(new PolymorpheusComponent(SwapModalComponent, this.injector), {
      size: 'l',
      data: { amount, blockchain }
    });
  }

  /**
   * Gets bridge trade object.
   * @param fromBlockchain Selected token blockchain.
   * @param amount Amount that user wants to stake.
   * @return BridgeTrade
   */
  private getBridgeTradeObject(fromBlockchain: BLOCKCHAIN_NAME, amount: BigNumber): BridgeTrade {
    switch (fromBlockchain) {
      case BLOCKCHAIN_NAME.POLYGON:
        return {
          provider: BRIDGE_PROVIDER.SWAP_RBC,
          token: {
            symbol: 'RBC',
            image: 'assets/images/icons/staking/rbc-pos.svg',
            rank: TOKEN_RANK.HIGH,
            tokenByBlockchain: {
              [BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN]: {
                blockchain: BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN,
                address: '0x8E3BCC334657560253B83f08331d85267316e08a',
                name: 'BRBC',
                symbol: 'BRBC',
                decimals: 18,

                minAmount: 100,
                maxAmount: 100000
              },
              [BLOCKCHAIN_NAME.POLYGON]: {
                blockchain: BLOCKCHAIN_NAME.POLYGON,
                address: '0xc3cFFDAf8F3fdF07da6D5e3A89B8723D5E385ff8',
                name: 'Rubic (pos)',
                symbol: 'RBC',
                decimals: 18,

                minAmount: 100,
                maxAmount: 100100
              }
            }
          },
          fromBlockchain,
          toBlockchain: BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN,
          amount,
          toAddress: this.bridgeContractAddress,
          onTransactionHash: async (txHash: string) => {
            await this.stakingApiService
              .sendBridgeTxHash({ txHash, network: 'polygon' })
              .toPromise();
          }
        };
      case BLOCKCHAIN_NAME.ETHEREUM:
        return {
          provider: BRIDGE_PROVIDER.SWAP_RBC,
          token: {
            symbol: 'RBC',
            image: 'assets/images/icons/staking/rbc-eth.svg',
            rank: TOKEN_RANK.HIGH,
            tokenByBlockchain: {
              [BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN]: {
                blockchain: BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN,
                address: '0x8E3BCC334657560253B83f08331d85267316e08a',
                name: 'BRBC',
                symbol: 'BRBC',
                decimals: 18,

                minAmount: 200,
                maxAmount: 100000
              },
              [BLOCKCHAIN_NAME.ETHEREUM]: {
                blockchain: BLOCKCHAIN_NAME.ETHEREUM,
                address: '0xA4EED63db85311E22dF4473f87CcfC3DaDCFA3E3',
                name: 'Rubic',
                symbol: 'RBC',
                decimals: 18,

                minAmount: 200,
                maxAmount: 100100
              }
            }
          },
          fromBlockchain,
          toBlockchain: BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN,
          amount,
          toAddress: this.bridgeContractAddress,
          onTransactionHash: async (txHash: string) => {
            await this.stakingApiService
              .sendBridgeTxHash({ txHash, network: 'ethereum' })
              .toPromise();
          }
        };
    }
  }

  /**
   * Gets Rubic bridge provider service.
   * @param blockchain Selected token blockchain.
   * @return BinancePolygonRubicBridgeProviderService | EthereumBinanceRubicBridgeProviderService
   */
  private getRubicBridge(
    blockchain: BLOCKCHAIN_NAME
  ): BinancePolygonRubicBridgeProviderService | EthereumBinanceRubicBridgeProviderService {
    if (blockchain === BLOCKCHAIN_NAME.POLYGON) {
      return this.polygonBinanceBridge;
    } else if (blockchain === BLOCKCHAIN_NAME.ETHEREUM) {
      return this.ethereumBinanceBridge;
    }
  }

  /**
   * Gets BRBC usd price every BRBC_USD_PRICE_UPDATE_TIME millisecond.
   * @return Observable<number>
   */
  public watchBRBCUsdPrice(): Observable<number> {
    const { blockchain, address } = STAKING_TOKENS[0];
    return interval(this.BRBC_USD_PRICE_UPDATE_TIME).pipe(
      startWith(0),
      switchMap(() =>
        from(this.tokensService.getAndUpdateTokenPrice({ address, blockchain }, true))
      ),
      tap(response => (this.BRBCUsdPrice = response))
    );
  }
}
